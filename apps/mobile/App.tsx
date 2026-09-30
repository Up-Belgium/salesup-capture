// salesUp Capture — iOS/Android app
// 2026 light-theme. Kernidee: opnemen moet in één gebaar kunnen.
//  - Groot één-tik opnameveld op het hoofdscherm.
//  - Snelstart via deep link salesupcapture://record → opent de app en start
//    meteen (koppelbaar aan Back Tap, Action Button, Siri of Bedieningspaneel
//    via de iOS Opdrachten-app — "Open URL salesupcapture://record").
//  - Staande consent-instelling (zoals afgesproken) zodat snelstart GDPR-proof
//    blijft: de gebruiker bevestigt één keer dat hij gesprekspartners informeert.
// Backend: ingest context/start/append/reupload/complete/match_orphans, bot_start,
// calendar-oauth.
// Uploads lopen via een duurzame wachtrij (src/uploadQueue.ts): een opname gaat
// nooit meer verloren als het versturen mislukt of de app gesloten wordt.

import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  ActivityIndicator, Alert, AppState, KeyboardAvoidingView, Linking, Platform, Pressable,
  ScrollView, StyleSheet, Switch, Text, TextInput, View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useAudioRecorder, AudioModule, RecordingPresets, setAudioModeAsync } from 'expo-audio';
import type { RecordingOptions } from 'expo-audio';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
// Legacy-import: uploadAsync (streaming PUT, ideaal voor grote audio) is in
// expo-file-system SDK 54+ uit de hoofd-entry weggehaald en gooit daar nu een
// deprecation-fout. De legacy-API blijft volledig werken met dezelfde signatuur.
import * as FileSystem from 'expo-file-system/legacy';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, Session } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './src/config';
import {
  ingest, processQueue, subscribe, enqueueSegment, enqueueRescued, finalizeGroup, removeGroup,
  getQueue, newLocalId, setCurrentGroupId, getCurrentGroupId, maybeNotify, scanOrphans,
  QueueGroup, QueueState, OrphanFile,
} from './src/uploadQueue';

// Toon meeting-herinneringen ook als de app open is.
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

// Vraag pushrechten, haal de Expo-token en registreer 'm bij de backend.
async function registerForPush(accessToken: string) {
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('meetings', {
        name: 'Meetings', importance: Notifications.AndroidImportance.HIGH, sound: 'default',
      });
    }
    const cur = await Notifications.getPermissionsAsync();
    let granted = cur.granted || cur.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
    if (!granted) granted = (await Notifications.requestPermissionsAsync()).granted;
    if (!granted) return;
    const projectId = (Constants?.expoConfig as any)?.extra?.eas?.projectId;
    const token = (await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined)).data;
    if (!token) return;
    await fetch(`${SUPABASE_URL}/functions/v1/register-push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ token }),
    });
  } catch { /* push is best-effort */ }
}

const C = {
  bg: '#eef1f6', surface: '#ffffff', ink: '#1a2540', muted: '#6b7488',
  line: '#e4e8f0', orange: '#FF6B35', orangeSoft: '#fff3ee', green: '#15936b', red: '#e2483f',
};

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { storage: AsyncStorage, autoRefreshToken: true, persistSession: true, detectSessionInUrl: false },
});

type Ctx = { role: string; participant_id: string | null; orgs: { id: string; name: string }[] };
type RecordingType = 'in_person' | 'phone' | 'video_meeting';
const TYPE_LABELS: Record<RecordingType, string> = {
  in_person: 'Fysieke meeting', phone: 'Telefoon (speaker)', video_meeting: 'Videocall',
};

// Spraakpreset: mono AAC ~64 kbps @ 44,1 kHz (HIGH_QUALITY was stereo 128 kbps →
// ~70 MB per 75 min; dit halveert de bestandsgrootte en ruim genoeg voor spraak/
// transcriptie). numberOfChannels/bitRate staan op het hoogste niveau: expo-audio
// past die toe op iOS én Android (de platform-subobjecten kennen die velden niet).
// directory 'document': iOS/Android mogen de documentmap — anders dan de cache —
// niet zelf opruimen bij plaatsgebrek.
const SPEECH_PRESET: RecordingOptions = {
  ...RecordingPresets.HIGH_QUALITY,
  directory: 'document',
  sampleRate: 44100,
  numberOfChannels: 1,
  bitRate: 64000,
  ios: { ...RecordingPresets.HIGH_QUALITY.ios, sampleRate: 44100 },
  android: { ...RecordingPresets.HIGH_QUALITY.android, sampleRate: 44100 },
};

// Automatische segment-rotatie tijdens lange opnames: elke SEGMENT_MINUTES wordt
// het huidige deel afgesloten en meteen een nieuw deel gestart (zelfde opname/
// groep). Het afgewerkte deel gaat al op de achtergrond de wachtrij in, zodat een
// lange meeting nooit één reusbestand wordt en bij een crash hooguit het laatste
// deel verloren gaat. Enkel terwijl de app op de voorgrond staat (anders bij de
// volgende kans). ⚠️ Vereist test op een echt toestel (iOS én Android): bij de
// rotatie valt een kort audiogat (~0,1–0,5 s). Zet ROTATION_ENABLED op false om
// uit te schakelen.
const ROTATION_ENABLED = true;
const SEGMENT_MINUTES = 20;

async function getToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}
const runQueue = () => processQueue({ getToken });

const fmtDate = (iso: string | number) =>
  new Date(iso).toLocaleString('nl-BE', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtMb = (bytes: number) => (bytes / 1_000_000).toFixed(bytes >= 10_000_000 ? 0 : 1);

type OrphanMatch = {
  recording_id: string; org_id: string; status: string; has_file: boolean;
  storage_path: string | null; started_at: string; title: string | null; recording_type: RecordingType;
} | null;
type OrphanItem = OrphanFile & { match: OrphanMatch };
type GroupMeta = { localId: string; orgId: string; recType: RecordingType; title: string | null; startedAt: string };

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setBooting(false); });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  // Push registreren zodra er een sessie is.
  useEffect(() => { if (session?.access_token) registerForPush(session.access_token); }, [session?.access_token]);

  // Tik op een meeting-herinnering → open de opnamemodus (via de bestaande deep link).
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((resp) => {
      const data = resp.notification.request.content.data as any;
      if (data?.type === 'record') Linking.openURL('salesupcapture://record').catch(() => {});
    });
    return () => sub.remove();
  }, []);

  if (booting) return <View style={[styles.screen, styles.center]}><ActivityIndicator color={C.orange} size="large" /></View>;
  return (
    <View style={styles.screen}>
      <StatusBar style="dark" />
      {session ? <Recorder session={session} /> : <Login />}
    </View>
  );
}

// ── Login (+ wachtwoord-reset via e-mailcode) ─────────────────────────────────
type LoginMode = 'login' | 'reset_request' | 'reset_verify';

function Login() {
  const [mode, setMode] = useState<LoginMode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  async function submit() {
    setBusy(true); setError('');
    const { error: err } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (err) setError('Inloggen mislukt — controleer e-mail en wachtwoord.');
    setBusy(false);
  }

  // Stap 1: verstuur een code naar de mailbox.
  async function requestCode() {
    if (!email.trim()) { setError('Vul eerst je e-mailadres in.'); return; }
    setBusy(true); setError(''); setInfo('');
    const { error: err } = await supabase.auth.resetPasswordForEmail(email.trim());
    if (err) setError(/rate|limit|seconds/i.test(err.message || '')
      ? 'Te veel pogingen — wacht even en probeer opnieuw.'
      : 'Kon geen code versturen — controleer je e-mailadres.');
    else { setMode('reset_verify'); setInfo('We stuurden een code naar je mailbox.'); }
    setBusy(false);
  }

  // Stap 2: verifieer de code en zet meteen het nieuwe wachtwoord.
  async function verifyAndSet() {
    if (code.trim().length < 4 || newPassword.length < 8) {
      setError('Vul de code uit de e-mail in en een wachtwoord van minstens 8 tekens.'); return;
    }
    setBusy(true); setError(''); setInfo('');
    const { error: vErr } = await supabase.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: 'recovery' });
    if (vErr) { setError('Code ongeldig of verlopen — vraag een nieuwe aan.'); setBusy(false); return; }
    const { error: uErr } = await supabase.auth.updateUser({ password: newPassword });
    if (uErr) { setError('Kon wachtwoord niet instellen — probeer opnieuw.'); setBusy(false); return; }
    // Sessie is nu actief → onAuthStateChange opent de app automatisch.
  }

  function backToLogin() {
    setMode('login'); setError(''); setInfo(''); setCode(''); setNewPassword('');
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.center}>
      <Wordmark />
      <Text style={styles.subtitle}>
        {mode === 'login' ? 'Log in met je salesUp-account'
          : mode === 'reset_request' ? 'Wachtwoord opnieuw instellen'
          : 'Voer de code in en kies een nieuw wachtwoord'}
      </Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {info ? <Text style={styles.success}>{info}</Text> : null}

      {mode === 'login' && (
        <View style={styles.card}>
          <TextInput style={styles.input} placeholder="E-mailadres" placeholderTextColor="#aab0bf"
            autoCapitalize="none" keyboardType="email-address" value={email} onChangeText={setEmail} />
          <TextInput style={styles.input} placeholder="Wachtwoord" placeholderTextColor="#aab0bf"
            secureTextEntry value={password} onChangeText={setPassword} />
          <Pressable style={[styles.primary, busy && styles.disabled]} onPress={submit} disabled={busy}>
            <Text style={styles.primaryText}>{busy ? 'Bezig…' : 'Inloggen'}</Text>
          </Pressable>
          <Pressable style={styles.linkBtn} onPress={() => { setMode('reset_request'); setError(''); }}>
            <Text style={styles.link}>Wachtwoord vergeten?</Text>
          </Pressable>
        </View>
      )}

      {mode === 'reset_request' && (
        <View style={styles.card}>
          <TextInput style={styles.input} placeholder="E-mailadres" placeholderTextColor="#aab0bf"
            autoCapitalize="none" keyboardType="email-address" value={email} onChangeText={setEmail} />
          <Pressable style={[styles.primary, busy && styles.disabled]} onPress={requestCode} disabled={busy}>
            <Text style={styles.primaryText}>{busy ? 'Bezig…' : 'Stuur code'}</Text>
          </Pressable>
          <Pressable style={styles.linkBtn} onPress={backToLogin}><Text style={styles.link}>Terug naar inloggen</Text></Pressable>
        </View>
      )}

      {mode === 'reset_verify' && (
        <View style={styles.card}>
          <TextInput style={styles.input} placeholder="Code uit de e-mail" placeholderTextColor="#aab0bf"
            autoCapitalize="none" autoCorrect={false} value={code} onChangeText={setCode} />
          <TextInput style={styles.input} placeholder="Nieuw wachtwoord (min. 8 tekens)" placeholderTextColor="#aab0bf"
            secureTextEntry value={newPassword} onChangeText={setNewPassword} />
          <Pressable style={[styles.primary, busy && styles.disabled]} onPress={verifyAndSet} disabled={busy}>
            <Text style={styles.primaryText}>{busy ? 'Bezig…' : 'Wachtwoord instellen'}</Text>
          </Pressable>
          <Pressable style={styles.linkBtn} onPress={requestCode} disabled={busy}><Text style={styles.link}>Geen code ontvangen? Stuur opnieuw</Text></Pressable>
          <Pressable style={styles.linkBtn} onPress={backToLogin}><Text style={styles.link}>Terug naar inloggen</Text></Pressable>
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

function Wordmark() {
  return <Text style={styles.logo}>sales<Text style={{ color: C.orange }}>Up</Text> Capture</Text>;
}

// ── Recorder ─────────────────────────────────────────────────────────────────
function Recorder({ session }: { session: Session }) {
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [ctxError, setCtxError] = useState('');
  const [clientId, setClientId] = useState('');
  const [recType, setRecType] = useState<RecordingType>('in_person');
  const [title, setTitle] = useState('');
  const [standingConsent, setStandingConsent] = useState(false);
  const [quickStart, setQuickStart] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [botUrl, setBotUrl] = useState('');
  const [botBusy, setBotBusy] = useState(false);

  // Stabiele statusListener → delegeert naar de laatste handler (via ref) zodat
  // hij altijd de actuele state ziet. Vangt systeem-interrupties (telefoon-
  // oproep, media-daemon-reset) op de opnamesessie.
  const onStatusRef = useRef<(s: any) => void>(() => {});
  const tickRef = useRef<() => void>(() => {}); // elke seconde tijdens de opname (rotatie-check)
  const recorder = useAudioRecorder(SPEECH_PRESET, (status) => onStatusRef.current?.(status));
  const recordingActive = useRef(false);
  const interruptedRef = useRef(false); // true = opname onderbroken (bv. oproep), klaar om te hervatten
  const restoredRef = useRef(false);    // onderbroken opname teruggezet na herstart → NIET automatisch hervatten
  // Huidige opname (groep in de upload-wachtrij). Alle segmenten van één opname
  // hangen aan dezelfde localId; ook bewaard in AsyncStorage (herstart-proof).
  const groupRef = useRef<GroupMeta | null>(null);
  const groupDurRef = useRef(0);        // som van de al afgewerkte segmentduren
  const segStartRef = useRef(0);        // start (ms) van het lopende segment
  const rotatingRef = useRef<Promise<void> | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [phase, setPhase] = useState<'idle' | 'recording' | 'uploading' | 'done' | 'failed' | 'interrupted'>('idle');
  const phaseRef = useRef(phase);
  const [message, setMessage] = useState('');
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const clientIdRef = useRef('');
  const consentRef = useRef(false);
  const recTypeRef = useRef<RecordingType>('in_person');
  const titleRef = useRef('');
  const [queue, setQueue] = useState<QueueGroup[]>([]);
  const [qState, setQState] = useState<QueueState>({ busy: false, progress: null });
  const [orphans, setOrphans] = useState<OrphanItem[]>([]);

  useEffect(() => { clientIdRef.current = clientId; }, [clientId]);
  useEffect(() => { consentRef.current = standingConsent; }, [standingConsent]);
  useEffect(() => { recTypeRef.current = recType; }, [recType]);
  useEffect(() => { titleRef.current = title; }, [title]);
  useEffect(() => { phaseRef.current = phase; }, [phase]);

  // instellingen laden
  useEffect(() => {
    (async () => {
      const [sc, qs] = await Promise.all([
        AsyncStorage.getItem('standingConsent'), AsyncStorage.getItem('quickStart'),
      ]);
      if (sc === '1') setStandingConsent(true);
      if (qs === '1') setQuickStart(true);
    })();
  }, []);
  const persist = (k: string, v: boolean) => AsyncStorage.setItem(k, v ? '1' : '0');

  // context laden
  useEffect(() => {
    (async () => {
      try {
        const json = await ingest('context', {}, session.access_token);
        setCtx(json);
        if (json.orgs?.length === 1) setClientId(json.orgs[0].id);
      } catch (e: any) {
        setCtxError(e.message === 'unauthorized'
          ? 'Geen toegang — dit account is niet gekoppeld aan salesUp Capture.'
          : `Kon profiel niet laden: ${e.message}`);
      }
    })();
  }, [session.access_token]);

  // ── Upload-wachtrij: UI volgen + verwerken zodra er een sessie is ─────────
  useEffect(() => subscribe((q, s) => { setQueue(q); setQState(s); }), []);
  useEffect(() => { runQueue(); }, [session.access_token]);

  // Onderbroken opname van een vorige app-sessie terugzetten (bv. app gesloten na
  // een oproep): zelfde groep, zodat Hervatten verder opneemt in DEZELFDE opname.
  // Na 12 uur hervat niemand nog → automatisch afronden met wat er is.
  useEffect(() => {
    (async () => {
      const id = await getCurrentGroupId();
      if (!id || recordingActive.current) return;
      const g = (await getQueue()).find((x) => x.localId === id);
      if (!g || g.finalized) { await setCurrentGroupId(null); return; }
      if (Date.now() - new Date(g.updatedAt).getTime() > 12 * 3600_000) {
        await finalizeGroup(id); await setCurrentGroupId(null); runQueue(); return;
      }
      groupRef.current = { localId: g.localId, orgId: g.orgId, recType: g.recType, title: g.title, startedAt: g.startedAt };
      groupDurRef.current = g.segments.reduce((sum, sg) => sum + (sg.duration || 0), 0);
      interruptedRef.current = true;
      restoredRef.current = true;
      setRecType(g.recType);
      if (g.title) setTitle(g.title);
      setPhase('interrupted');
      setMessage('Je vorige opname werd onderbroken (de app werd afgesloten). Het opgenomen deel is bewaard. Tik op Hervatten om verder op te nemen in dezelfde opname, of rond af.');
    })();
  }, []);

  // Orphan recovery: audiobestanden op het toestel die niet in de wachtrij staan
  // (bv. een mislukte upload uit een oudere app-versie, zoals het incident van
  // 2026-09-28). De server koppelt ze aan een bestaande opname (redden via
  // reupload), meldt dat ze al verstuurd zijn (verbergen) of kent ze niet
  // (aanbieden als nieuwe opname).
  const scanForOrphans = useCallback(async () => {
    if (recordingActive.current) return;
    try {
      const files = await scanOrphans([recorder.uri]);
      if (files.length === 0) { setOrphans([]); return; }
      const token = await getToken();
      if (!token) return;
      const res = await ingest('match_orphans', {
        files: files.map((f) => ({ key: f.uri, modified_at: new Date(f.modifiedAt).toISOString(), size: f.size })),
      }, token);
      const byKey = new Map<string, OrphanMatch>((res.matches ?? []).map((m: any) => [m.key, m.match]));
      const items: OrphanItem[] = [];
      for (const f of files) {
        const m = byKey.get(f.uri) ?? null;
        if (m && (m.has_file || !['pending_upload', 'error'].includes(m.status))) continue; // al verstuurd
        items.push({ ...f, match: m });
      }
      setOrphans(items);
    } catch { /* offline of serverfout: volgende opstart opnieuw */ }
  }, []);
  useEffect(() => { if (ctx) scanForOrphans(); }, [ctx, scanForOrphans]);

  async function sendOrphan(o: OrphanItem) {
    try {
      if (o.match) {
        await enqueueRescued({
          uri: o.uri, orgId: o.match.org_id, recType: o.match.recording_type, title: o.match.title,
          startedAt: o.match.started_at, duration: o.estDuration,
          recordingId: o.match.recording_id, storagePath: o.match.storage_path,
        });
      } else {
        const org = clientIdRef.current;
        if (!org) { Alert.alert('Kies een klant', 'Selecteer onder "Meer opties" voor welke klant deze opname is.'); return; }
        await enqueueRescued({
          uri: o.uri, orgId: org, recType: recTypeRef.current, title: 'Herstelde opname',
          startedAt: new Date(o.modifiedAt - o.estDuration * 1000).toISOString(), duration: o.estDuration,
        });
      }
      setOrphans((list) => list.filter((x) => x.uri !== o.uri));
      runQueue();
    } catch (e: any) { Alert.alert('Versturen', e.message); }
  }

  function deleteOrphan(o: OrphanItem) {
    Alert.alert('Opname verwijderen?', 'Dit audiobestand wordt definitief van dit toestel verwijderd en kan daarna niet meer verstuurd worden.', [
      { text: 'Annuleren', style: 'cancel' },
      { text: 'Verwijderen', style: 'destructive', onPress: async () => {
        await FileSystem.deleteAsync(o.uri, { idempotent: true }).catch(() => {});
        setOrphans((list) => list.filter((x) => x.uri !== o.uri));
      } },
    ]);
  }

  const segDur = () => Math.max(0, Math.round((Date.now() - segStartRef.current) / 1000));

  // Afgewerkt segment → duurzaam in de wachtrij (bestand wordt verhuisd naar
  // documentDirectory/pending/). finalize=true: laatste segment van de opname.
  async function finishSegment(uri: string, dur: number, finalize: boolean) {
    const meta = groupRef.current;
    if (!meta) return;
    groupDurRef.current += dur;
    await enqueueSegment(meta, uri, dur, finalize);
    if (finalize) { groupRef.current = null; groupDurRef.current = 0; await setCurrentGroupId(null); }
  }

  const start = useCallback(async (opts?: { fromDeepLink?: boolean; resume?: boolean }) => {
    if (recordingActive.current) return; // al bezig
    if (!consentRef.current) {
      Alert.alert('Eerst consent', 'Zet "Ik informeer mijn gesprekspartners" aan om (snel) te kunnen opnemen.');
      return;
    }
    const resuming = !!opts?.resume && !!groupRef.current;
    const org = resuming ? groupRef.current!.orgId : clientIdRef.current;
    if (!org) { Alert.alert('Kies een klant', 'Selecteer onder "Meer opties" voor welke klant je opneemt.'); return; }
    const perm = await AudioModule.requestRecordingPermissionsAsync();
    if (!perm.granted) { Alert.alert('Microfoon vereist', 'Geef toegang tot de microfoon om op te nemen.'); return; }
    // shouldPlayInBackground houdt de opname-sessie actief als het scherm
    // vergrendelt of de app naar de achtergrond gaat (werkt op iOS enkel met
    // allowsRecording:true + UIBackgroundModes:["audio"] in app.json). Zonder
    // dit stopt iOS de opname zodra de telefoon in sluimerstand gaat.
    // shouldPlayInBackground enkel op iOS: daar houdt het de opname-sessie actief
    // in sluimerstand. Op Android loopt de opname door via de microfoon-
    // foreground-service; shouldPlayInBackground zou daar onnodig de
    // MEDIA_PLAYBACK-foreground-service triggeren (die we niet gebruiken).
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, shouldPlayInBackground: Platform.OS === 'ios' });
    // Altijd MET opties voorbereiden: dan maakt expo-audio een NIEUW bestand aan.
    // Zonder opties hergebruikt iOS dezelfde AVAudioRecorder (zelfde bestandspad)
    // en zou een nog niet verstuurd vorig segment overschreven worden.
    await recorder.prepareToRecordAsync(SPEECH_PRESET);
    recorder.record();
    recordingActive.current = true;
    interruptedRef.current = false;
    restoredRef.current = false;
    segStartRef.current = Date.now();
    if (!resuming) {
      // nieuwe opname → nieuwe groep in de wachtrij
      const meta: GroupMeta = {
        localId: newLocalId(), orgId: org, recType: recTypeRef.current,
        title: (titleRef.current || '').trim() || null, startedAt: new Date().toISOString(),
      };
      groupRef.current = meta; groupDurRef.current = 0;
      await setCurrentGroupId(meta.localId);
    }
    // Scherm wakker houden tijdens de opname: anders gaat de telefoon in
    // auto-sluimerstand en stopt iOS de opname (naast de background-audio-modus).
    activateKeepAwakeAsync().catch(() => {});
    setSeconds(groupDurRef.current); setPhase('recording'); setMessage('');
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(() => { setSeconds((s) => s + 1); tickRef.current(); }, 1000);
  }, []);

  // ── Deep link: salesupcapture://record → meteen opnemen ──────────────────
  const handleUrl = useCallback((url: string | null) => {
    if (url && /record/i.test(url)) {
      // korte vertraging zodat ctx/instellingen geladen zijn
      setTimeout(() => start({ fromDeepLink: true }), 350);
    }
  }, [start]);
  useEffect(() => {
    Linking.getInitialURL().then(handleUrl);
    const sub = Linking.addEventListener('url', (e) => handleUrl(e.url));
    return () => sub.remove();
  }, [handleUrl]);

  // Hervat na een onderbreking: start een nieuw segment in dezelfde groep.
  const resume = useCallback(() => {
    interruptedRef.current = false;
    start({ resume: true }); // zelfde groep (groupRef blijft) → nieuw segment
  }, [start]);

  // App weer op de voorgrond: wachtrij verwerken, en automatisch hervatten na een
  // onderbreking (bv. een oproep) zolang consent nog gezet is — NIET voor een
  // opname die na een herstart werd teruggezet (daar beslist de gebruiker zelf).
  // Naar de achtergrond met mislukte uploads → één lokale melding.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active') {
        runQueue();
        if (interruptedRef.current && !restoredRef.current && !recordingActive.current
            && consentRef.current && groupRef.current) {
          resume();
        }
      } else if (st === 'background') {
        maybeNotify(null, false);
      }
    });
    return () => sub.remove();
  }, [resume]);

  async function stopAndUpload() {
    if (!recordingActive.current) return;
    if (rotatingRef.current) await rotatingRef.current.catch(() => {}); // lopende rotatie eerst afwerken
    if (!recordingActive.current) return; // rotatie mislukte → onderbroken-scherm staat al
    Promise.resolve(deactivateKeepAwake()).catch(() => {});
    if (timer.current) clearInterval(timer.current);
    setPhase('uploading');
    const meta = groupRef.current;
    try {
      const dur = segDur();
      await recorder.stop();
      const uri = recorder.uri ?? '';
      recordingActive.current = false;
      if (uri && dur >= 1) await finishSegment(uri, dur, true);
      else if (meta) { await finalizeGroup(meta.localId); groupRef.current = null; groupDurRef.current = 0; await setCurrentGroupId(null); }
      const queued = meta ? (await getQueue()).some((g) => g.localId === meta.localId) : false;
      if (!queued) throw new Error('Geen opnamebestand gevonden.');
      setTitle('');
      setPhase('done'); setMessage('Opname bewaard op dit toestel — wordt nu verstuurd…');
      runQueue().then(async () => {
        if (phaseRef.current !== 'done' && phaseRef.current !== 'failed') return; // intussen nieuwe opname
        const still = (await getQueue()).find((g) => g.localId === meta!.localId);
        if (!still) { setPhase('done'); setMessage('Opname verstuurd — verslag volgt automatisch per mail.'); }
        else {
          setPhase('failed');
          setMessage(`Versturen nog niet gelukt${still.lastError ? `: ${still.lastError}` : ''}. De opname is veilig bewaard op dit toestel en wordt automatisch opnieuw verstuurd.`);
        }
      });
    } catch (e: any) {
      recordingActive.current = false;
      setPhase('failed'); setMessage(`Opname stoppen mislukt: ${e.message}`);
    }
  }

  // Systeem-interruptie (telefoonoproep, media-daemon-reset): iOS breekt de
  // opnamesessie af en de recorder wordt ongeldig. We finaliseren het reeds
  // opgenomen deel en zetten het duurzaam in de wachtrij (niet afsluiten: na
  // Hervatten volgt een nieuw segment in dezelfde opname).
  async function handleInterruption(status: any) {
    if (!recordingActive.current || rotatingRef.current) return;
    recordingActive.current = false;
    interruptedRef.current = true; // klaar om te hervatten (automatisch of via de knop)
    if (timer.current) clearInterval(timer.current);
    const dur = segDur();
    setPhase('uploading');
    setMessage('Opname onderbroken (bv. door een oproep) — het opgenomen deel wordt bewaard.');
    try {
      let uri = status?.url ?? '';
      if (!uri) { try { await recorder.stop(); } catch { /* recorder al ongeldig */ } uri = recorder.uri ?? ''; }
      if (!uri || dur < 1) {
        // Nog niets opgenomen: niets te bewaren, maar wel meteen kunnen hervatten.
        setPhase('interrupted');
        setMessage('Opname onderbroken (bv. een oproep) vóór er iets werd opgenomen. Tik op Hervatten om verder op te nemen.');
        return;
      }
      await finishSegment(uri, dur, false); // segment bewaren, opname NIET afsluiten
      runQueue();
      setPhase('interrupted');
      setMessage('Opname onderbroken (bv. een oproep). Het opgenomen deel is veilig bewaard en wordt verstuurd. Tik op Hervatten om verder op te nemen.');
    } catch (e: any) {
      setPhase('interrupted');
      setMessage(`Opname onderbroken; het opgenomen deel kon niet bewaard worden (${e.message}). Tik op Hervatten om verder op te nemen.`);
    }
  }

  // Automatische segment-rotatie (zie ROTATION_ENABLED/SEGMENT_MINUTES): huidig
  // deel stoppen, meteen een nieuw deel starten, afgewerkt deel op de achtergrond
  // in de wachtrij. Mislukt het starten van het nieuwe deel, dan gedragen we ons
  // als bij een onderbreking (deel bewaard, Hervatten mogelijk).
  function rotateSegment() {
    if (rotatingRef.current || !recordingActive.current) return;
    const p = (async () => {
      const dur = segDur();
      let uri = '';
      try {
        await recorder.stop();
        uri = recorder.uri ?? ''; // lezen VÓÓR prepare: die maakt een nieuw bestand aan
        await recorder.prepareToRecordAsync(SPEECH_PRESET);
        recorder.record();
        segStartRef.current = Date.now();
      } catch (e: any) {
        recordingActive.current = false;
        interruptedRef.current = true;
        if (timer.current) clearInterval(timer.current);
        setPhase('interrupted');
        setMessage(`De opname wordt automatisch in delen opgeslagen, maar het volgende deel kon niet starten (${e?.message ?? e}). Het opgenomen deel is bewaard. Tik op Hervatten om verder op te nemen.`);
      }
      if (uri && dur >= 1) {
        try { await finishSegment(uri, dur, false); } catch { /* bestand blijft staan → orphan recovery */ }
        runQueue();
      }
    })();
    rotatingRef.current = p;
    p.finally(() => { if (rotatingRef.current === p) rotatingRef.current = null; });
  }

  // Houd de listeners bij de actuele closure.
  useEffect(() => {
    onStatusRef.current = (status: any) => {
      if (!recordingActive.current || status?.isFinished) return;
      if (status?.mediaServicesDidReset || status?.hasError) handleInterruption(status);
    };
    tickRef.current = () => {
      if (!ROTATION_ENABLED || !recordingActive.current || rotatingRef.current) return;
      if (Date.now() - segStartRef.current < SEGMENT_MINUTES * 60_000) return;
      if (AppState.currentState !== 'active') return; // niet op de achtergrond; volgende kans
      rotateSegment();
    };
  });

  // Onderbroken opname afsluiten zonder te hervatten → één verslag van de delen.
  async function finishInterrupted() {
    interruptedRef.current = false;
    restoredRef.current = false;
    Promise.resolve(deactivateKeepAwake()).catch(() => {});
    const meta = groupRef.current;
    groupRef.current = null; groupDurRef.current = 0;
    await setCurrentGroupId(null);
    setTitle('');
    if (!meta) { setPhase('idle'); setMessage(''); return; }
    await finalizeGroup(meta.localId);
    const queued = (await getQueue()).some((g) => g.localId === meta.localId);
    if (!queued) { setPhase('done'); setMessage('Opname afgerond — er werd niets opgenomen.'); return; }
    setPhase('done'); setMessage('Opname afgerond en wordt verstuurd — verslag volgt automatisch per mail.');
    runQueue();
  }

  function confirmRemoveGroup(g: QueueGroup) {
    Alert.alert('Uit de wachtrij verwijderen?', 'Het audiobestand van deze opname staat niet meer op dit toestel en kan niet meer verstuurd worden.', [
      { text: 'Annuleren', style: 'cancel' },
      { text: 'Verwijderen', style: 'destructive', onPress: () => { removeGroup(g.localId, true).catch(() => {}); } },
    ]);
  }

  const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');

  // Wachtrij voor de UI: de lopende (nog niet afgesloten) opname telt niet mee.
  const pending = queue.filter((g) => !(g.localId === groupRef.current?.localId && !g.finalized));
  const currentQueued = queue.find((g) => g.localId === groupRef.current?.localId) ?? null;
  const lastError = pending.find((g) => g.lastError)?.lastError ?? null;
  const prog = qState.progress;
  const progText = prog && prog.total > 0
    ? `Versturen… ${Math.round((prog.sent / prog.total) * 100)}% (${fmtMb(prog.sent)} van ${fmtMb(prog.total)} MB)`
    : 'Versturen…';

  if (ctxError) return (
    <View style={styles.center}>
      <Wordmark />
      <Text style={styles.error}>{ctxError}</Text>
      <Pressable style={styles.linkBtn} onPress={() => supabase.auth.signOut()}><Text style={styles.link}>Uitloggen</Text></Pressable>
    </View>
  );
  if (!ctx) return <View style={styles.center}><ActivityIndicator color={C.orange} size="large" /></View>;

  // ── Opnamescherm ─────────────────────────────────────────────────────────
  if (phase === 'recording') return (
    <View style={[styles.center, { padding: 28 }]}>
      <View style={styles.recRing}><View style={styles.recCore} /></View>
      <Text style={styles.timer}>{mm}:{ss}</Text>
      <Text style={styles.recHint}>Opname loopt. Houd het scherm aan tijdens de opname.{'\n'}{TYPE_LABELS[recType]}</Text>
      <Pressable style={[styles.primary, styles.stop]} onPress={stopAndUpload}>
        <Text style={styles.primaryText}>Stop &amp; verstuur</Text>
      </Pressable>
    </View>
  );

  // ── Onderbroken-scherm (bv. na een oproep) ───────────────────────────────
  if (phase === 'interrupted') return (
    <View style={[styles.center, { padding: 28 }]}>
      <Text style={{ fontSize: 44, marginBottom: 6 }}>⚠️</Text>
      <Text style={{ fontSize: 20, fontWeight: '700', color: C.ink, marginBottom: 8 }}>Opname onderbroken</Text>
      <Text style={[styles.recHint, { marginBottom: 22 }]}>
        {message || 'De opname werd onderbroken (bv. een oproep). Het opgenomen deel is bewaard.'}
      </Text>
      <Pressable style={styles.primary} onPress={resume}>
        <Text style={styles.primaryText}>Hervat opname</Text>
      </Pressable>
      {currentQueued?.lastError ? (
        <Text style={[styles.help, { marginTop: 14 }]}>
          Versturen van het opgenomen deel is nog niet gelukt — het staat veilig op dit toestel en wordt automatisch opnieuw geprobeerd.
        </Text>
      ) : null}
      <Pressable style={styles.linkBtn} onPress={finishInterrupted}>
        <Text style={styles.link}>Klaar, stoppen</Text>
      </Pressable>
    </View>
  );

  // ── Hoofdscherm ──────────────────────────────────────────────────────────
  const canRecord = standingConsent && !!clientId;
  return (
    <ScrollView contentContainerStyle={styles.container} showsVerticalScrollIndicator={false}>
      <Wordmark />

      {/* Grote één-tik opnameknop */}
      <Pressable
        style={({ pressed }) => [styles.bigRecord, !canRecord && styles.bigRecordOff, pressed && { transform: [{ scale: 0.97 }] }]}
        onPress={() => (phase === 'uploading' ? null : start())}>
        {phase === 'uploading'
          ? <ActivityIndicator color="#fff" size="large" />
          : <><Text style={styles.bigRecordDot}>●</Text><Text style={styles.bigRecordText}>Opname starten</Text></>}
      </Pressable>
      <Text style={styles.bigCaption}>
        {recType === 'phone' ? 'Telefoon: zet de speaker aan' : TYPE_LABELS[recType]}
      </Text>

      {/* Upload-wachtrij: opnames die nog niet (volledig) verstuurd zijn */}
      {pending.length > 0 && (
        <View style={[styles.card, styles.queueCard]}>
          <Text style={styles.queueTitle}>
            {pending.length === 1 ? '1 opname wacht op verzending' : `${pending.length} opnames wachten op verzending`}
          </Text>
          {qState.busy
            ? <Text style={styles.queueText}>{progText}</Text>
            : lastError ? <Text style={styles.queueErr}>Laatste fout: {lastError}</Text> : null}
          {pending.filter((g) => g.missingFile).map((g) => (
            <View key={g.localId} style={{ marginTop: 8 }}>
              <Text style={styles.queueText}>Opname van {fmtDate(g.startedAt)}: het audiobestand staat niet meer op dit toestel.</Text>
              <Pressable onPress={() => confirmRemoveGroup(g)}><Text style={styles.link}>Verwijder uit wachtrij</Text></Pressable>
            </View>
          ))}
          <Text style={styles.queueHint}>Houd de app open met een goede wifi- of 4G/5G-verbinding tot het versturen klaar is.</Text>
          <Pressable style={[styles.primary, qState.busy && styles.disabled]} disabled={qState.busy} onPress={() => { runQueue(); }}>
            <Text style={styles.primaryText}>{qState.busy ? 'Bezig met versturen…' : 'Nu versturen'}</Text>
          </Pressable>
        </View>
      )}

      {/* Teruggevonden, nooit verstuurde opnames op dit toestel */}
      {orphans.map((o) => (
        <View key={o.uri} style={[styles.card, styles.queueCard]}>
          <Text style={styles.queueTitle}>Onverstuurde opname gevonden</Text>
          <Text style={styles.queueText}>
            {o.match
              ? `Opname van ${fmtDate(o.match.started_at)}${o.match.title ? ` („${o.match.title}”)` : ''} · ca. ${Math.max(1, Math.round(o.estDuration / 60))} min · ${fmtMb(o.size)} MB`
              : `Opgeslagen op ${fmtDate(o.modifiedAt)} · ca. ${Math.max(1, Math.round(o.estDuration / 60))} min · ${fmtMb(o.size)} MB`}
          </Text>
          <Text style={styles.queueHint}>
            {o.match
              ? 'Deze opname is nooit bij ons aangekomen. Versturen of verwijderen?'
              : 'Niet gekoppeld aan een bekende opname — mogelijk al eerder verstuurd. Versturen of verwijderen?'}
          </Text>
          <View style={[styles.row, { marginTop: 4 }]}>
            <Pressable style={[styles.primary, { flex: 1 }]} onPress={() => sendOrphan(o)}>
              <Text style={styles.primaryText}>Versturen</Text>
            </Pressable>
            <Pressable style={[styles.secondary, { flex: 1, marginTop: 6 }]} onPress={() => deleteOrphan(o)}>
              <Text style={styles.secondaryText}>Verwijderen</Text>
            </Pressable>
          </View>
        </View>
      ))}

      {/* Type-segment */}
      <View style={styles.segment}>
        {(Object.keys(TYPE_LABELS) as RecordingType[]).map((t) => (
          <Pressable key={t} style={[styles.segItem, recType === t && styles.segItemOn]} onPress={() => setRecType(t)}>
            <Text style={[styles.segText, recType === t && styles.segTextOn]}>{TYPE_LABELS[t].split(' ')[0]}</Text>
          </Pressable>
        ))}
      </View>

      {/* Consent + snelstart */}
      <View style={styles.card}>
        <View style={styles.row}>
          <Switch value={standingConsent} onValueChange={(v) => { setStandingConsent(v); persist('standingConsent', v); }}
            trackColor={{ true: C.orange }} />
          <Text style={styles.rowText}>Ik informeer mijn gesprekspartners dat ik opneem (kwaliteit & training).</Text>
        </View>
        <View style={[styles.row, { marginTop: 14 }]}>
          <Switch value={quickStart} onValueChange={(v) => { setQuickStart(v); persist('quickStart', v); }}
            trackColor={{ true: C.orange }} />
          <Text style={styles.rowText}>Snelstart aan: één gebaar start meteen een opname.</Text>
        </View>
        {quickStart && (
          <Text style={styles.help}>
            Koppel in iOS → Instellingen → Toegankelijkheid → Aanraken → Tik op achterkant
            (of de Action Button / Siri) aan een Opdracht "Open URL" met{'\n'}
            <Text style={{ color: C.ink }}>salesupcapture://record</Text>{'\n'}
            Dubbeltik dan op de achterkant van je telefoon → de app opent en neemt meteen op.
          </Text>
        )}
      </View>

      {/* Meer opties (klant, agenda, bot, titel) */}
      <Pressable style={styles.moreToggle} onPress={() => setShowMore((s) => !s)}>
        <Text style={styles.moreText}>{showMore ? '− Minder opties' : '+ Meer opties'}</Text>
      </Pressable>

      {showMore && (
        <View style={styles.card}>
          {ctx.orgs.length > 1 && (
            <>
              <Text style={styles.label}>Klant</Text>
              <View style={styles.chips}>
                {ctx.orgs.map((c) => (
                  <Pressable key={c.id} style={[styles.chip, clientId === c.id && styles.chipOn]} onPress={() => setClientId(c.id)}>
                    <Text style={[styles.chipText, clientId === c.id && styles.chipTextOn]}>{c.name}</Text>
                  </Pressable>
                ))}
              </View>
            </>
          )}

          <Text style={styles.label}>Titel (optioneel)</Text>
          <TextInput style={styles.input} placeholder="bv. Demo-gesprek Acme NV" placeholderTextColor="#aab0bf"
            value={title} onChangeText={setTitle} />

          <Pressable style={[styles.secondary, { marginTop: 4 }]} onPress={async () => {
            try {
              const { data } = await supabase.auth.getSession();
              const token = data.session?.access_token ?? session.access_token;
              const res = await fetch(`${SUPABASE_URL}/functions/v1/calendar-oauth`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ action: 'auth_url' }),
              });
              const json = await res.json();
              if (!res.ok || json.ok === false) throw new Error(json.error || `Fout (${res.status})`);
              await Linking.openURL(json.url);
            } catch (e: any) { Alert.alert('Agenda verbinden', e.message); }
          }}>
            <Text style={styles.secondaryText}>📅 Verbind agenda (Google/Microsoft)</Text>
          </Pressable>

          <Text style={styles.label}>Of stuur de bot naar een meeting-link</Text>
          <TextInput style={styles.input} placeholder="Plak de Meet/Zoom/Teams-link" placeholderTextColor="#aab0bf"
            autoCapitalize="none" value={botUrl} onChangeText={setBotUrl} />
          <Pressable style={[styles.secondary, (botBusy || !botUrl.startsWith('http')) && styles.disabled]}
            disabled={botBusy || !botUrl.startsWith('http')}
            onPress={async () => {
              setBotBusy(true);
              try {
                const { data } = await supabase.auth.getSession();
                await ingest('bot_start', { meeting_url: botUrl.trim(), org_id: clientId || (ctx.orgs[0] && ctx.orgs[0].id), title: title || null },
                  data.session?.access_token ?? session.access_token);
                setBotUrl(''); setPhase('done'); setMessage('Bot is onderweg naar je meeting — verslag volgt per mail.');
              } catch (e: any) { setPhase('failed'); setMessage(`Bot sturen mislukt: ${e.message}`); }
              finally { setBotBusy(false); }
            }}>
            <Text style={styles.secondaryText}>{botBusy ? 'Bezig…' : '🤖 Stuur bot naar meeting'}</Text>
          </Pressable>
        </View>
      )}

      {message ? <Text style={phase === 'failed' ? styles.error : styles.success}>{message}</Text> : null}
      <Pressable style={styles.linkBtn} onPress={() => supabase.auth.signOut()}>
        <Text style={styles.link}>Uitloggen ({session.user.email})</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  container: { padding: 22, paddingTop: 64, alignItems: 'stretch' },
  logo: { fontSize: 26, fontWeight: '800', color: C.ink, textAlign: 'center', marginBottom: 6, letterSpacing: -0.4 },
  subtitle: { color: C.muted, textAlign: 'center', marginBottom: 22 },

  card: { backgroundColor: C.surface, borderRadius: 18, borderWidth: 1, borderColor: C.line, padding: 18, marginTop: 14, width: '100%' },
  input: { backgroundColor: '#fbfcfe', borderWidth: 1, borderColor: C.line, borderRadius: 12, color: C.ink, paddingHorizontal: 14, paddingVertical: 13, marginBottom: 10, fontSize: 15 },

  bigRecord: { backgroundColor: C.orange, borderRadius: 24, height: 132, alignItems: 'center', justifyContent: 'center', marginTop: 8,
    shadowColor: C.orange, shadowOpacity: 0.35, shadowRadius: 18, shadowOffset: { width: 0, height: 10 } },
  bigRecordOff: { backgroundColor: '#f0a888', shadowOpacity: 0.15 },
  bigRecordDot: { color: '#fff', fontSize: 30, marginBottom: 2 },
  bigRecordText: { color: '#fff', fontSize: 20, fontWeight: '800', letterSpacing: -0.3 },
  bigCaption: { textAlign: 'center', color: C.muted, fontSize: 12.5, marginTop: 10 },

  segment: { flexDirection: 'row', backgroundColor: '#e2e6ee', borderRadius: 12, padding: 3, marginTop: 18 },
  segItem: { flex: 1, paddingVertical: 9, borderRadius: 10, alignItems: 'center' },
  segItemOn: { backgroundColor: '#fff' },
  segText: { color: C.muted, fontSize: 13, fontWeight: '600' },
  segTextOn: { color: C.ink },

  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  rowText: { color: C.ink, fontSize: 13, flex: 1, lineHeight: 18 },
  help: { color: C.muted, fontSize: 12, lineHeight: 18, marginTop: 12, backgroundColor: C.orangeSoft, padding: 12, borderRadius: 10 },

  moreToggle: { alignSelf: 'center', marginTop: 16, padding: 6 },
  moreText: { color: C.orange, fontWeight: '700', fontSize: 13 },

  label: { color: C.muted, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 1, marginTop: 14, marginBottom: 7 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderColor: C.line, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
  chipOn: { backgroundColor: C.orange, borderColor: C.orange },
  chipText: { color: C.muted, fontSize: 13 },
  chipTextOn: { color: '#fff', fontWeight: '600' },

  primary: { backgroundColor: C.orange, borderRadius: 13, paddingVertical: 15, alignItems: 'center', marginTop: 6 },
  primaryText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  secondary: { backgroundColor: '#fff', borderWidth: 1, borderColor: C.line, borderRadius: 12, paddingVertical: 13, alignItems: 'center', marginTop: 10 },
  secondaryText: { color: C.ink, fontWeight: '600', fontSize: 14 },
  stop: { backgroundColor: C.red, marginTop: 28, paddingHorizontal: 40 },
  disabled: { opacity: 0.45 },

  recRing: { width: 110, height: 110, borderRadius: 55, backgroundColor: '#fde7e5', alignItems: 'center', justifyContent: 'center', marginBottom: 22 },
  recCore: { width: 22, height: 22, borderRadius: 11, backgroundColor: C.red },
  timer: { color: C.ink, fontSize: 60, fontVariant: ['tabular-nums'], fontWeight: '200' },
  recHint: { color: C.muted, textAlign: 'center', marginTop: 12, lineHeight: 20 },

  queueCard: { borderColor: '#f6c7b3', backgroundColor: C.orangeSoft },
  queueTitle: { color: C.ink, fontWeight: '700', fontSize: 15 },
  queueText: { color: C.ink, fontSize: 13, lineHeight: 18, marginTop: 6 },
  queueErr: { color: C.red, fontSize: 12.5, lineHeight: 18, marginTop: 6 },
  queueHint: { color: C.muted, fontSize: 12, lineHeight: 17, marginTop: 8 },

  error: { color: C.red, marginTop: 16, textAlign: 'center', lineHeight: 19 },
  success: { color: C.green, marginTop: 16, textAlign: 'center', lineHeight: 19 },
  linkBtn: { marginTop: 24, alignItems: 'center' },
  link: { color: C.muted, fontSize: 13, textDecorationLine: 'underline' },
});
