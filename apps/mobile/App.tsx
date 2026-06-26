// salesUp Capture — iOS/Android app
// 2026 light-theme. Kernidee: opnemen moet in één gebaar kunnen.
//  - Groot één-tik opnameveld op het hoofdscherm.
//  - Snelstart via deep link salesupcapture://record → opent de app en start
//    meteen (koppelbaar aan Back Tap, Action Button, Siri of Bedieningspaneel
//    via de iOS Opdrachten-app — "Open URL salesupcapture://record").
//  - Staande consent-instelling (zoals afgesproken) zodat snelstart GDPR-proof
//    blijft: de gebruiker bevestigt één keer dat hij gesprekspartners informeert.
// Backend ongewijzigd: ingest context/start/complete, bot_start, calendar-oauth.

import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  ActivityIndicator, Alert, KeyboardAvoidingView, Linking, Platform, Pressable,
  ScrollView, StyleSheet, Switch, Text, TextInput, View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useAudioRecorder, AudioModule, RecordingPresets, setAudioModeAsync } from 'expo-audio';
import * as FileSystem from 'expo-file-system';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, Session } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY, INGEST_URL } from './src/config';

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

async function ingest(action: string, body: Record<string, unknown>, token: string) {
  const res = await fetch(INGEST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action, ...body }),
  });
  const json = await res.json();
  if (!res.ok || json.ok === false) throw new Error(json.error || `Fout (${res.status})`);
  return json;
}

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

  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recordingActive = useRef(false);
  const [seconds, setSeconds] = useState(0);
  const [phase, setPhase] = useState<'idle' | 'recording' | 'uploading' | 'done' | 'failed'>('idle');
  const [message, setMessage] = useState('');
  const pendingUpload = useRef<{ uri: string; startedAt: string; duration: number } | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const clientIdRef = useRef('');
  const consentRef = useRef(false);

  useEffect(() => { clientIdRef.current = clientId; }, [clientId]);
  useEffect(() => { consentRef.current = standingConsent; }, [standingConsent]);

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

  const start = useCallback(async (opts?: { fromDeepLink?: boolean }) => {
    if (recordingActive.current) return; // al bezig
    if (!consentRef.current) {
      Alert.alert('Eerst consent', 'Zet "Ik informeer mijn gesprekspartners" aan om (snel) te kunnen opnemen.');
      return;
    }
    const org = clientIdRef.current;
    if (!org) { Alert.alert('Kies een klant', 'Selecteer onder "Meer opties" voor welke klant je opneemt.'); return; }
    const perm = await AudioModule.requestRecordingPermissionsAsync();
    if (!perm.granted) { Alert.alert('Microfoon vereist', 'Geef toegang tot de microfoon om op te nemen.'); return; }
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    await recorder.prepareToRecordAsync();
    recorder.record();
    recordingActive.current = true;
    setSeconds(0); setPhase('recording'); setMessage('');
    pendingUpload.current = null;
    timer.current = setInterval(() => setSeconds((s) => s + 1), 1000);
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

  async function stopAndUpload() {
    if (!recordingActive.current) return;
    if (timer.current) clearInterval(timer.current);
    setPhase('uploading');
    try {
      await recorder.stop();
      const uri = recorder.uri ?? '';
      recordingActive.current = false;
      if (!uri) throw new Error('Geen opnamebestand gevonden.');
      const startedAt = new Date(Date.now() - seconds * 1000).toISOString();
      pendingUpload.current = { uri, startedAt, duration: seconds };
      await upload(uri, startedAt, seconds);
      setPhase('done'); setMessage('Opname verstuurd — verslag volgt automatisch per mail.');
      setTitle(''); pendingUpload.current = null;
    } catch (e: any) {
      setPhase('failed'); setMessage(`Versturen mislukt: ${e.message}. De opname staat nog op dit toestel.`);
    }
  }

  async function upload(uri: string, startedAt: string, duration: number) {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error('Sessie verlopen — log opnieuw in.');
    const startJson = await ingest('start', {
      org_id: clientIdRef.current, recording_type: recType, title: title || null, started_at: startedAt, ext: 'm4a',
    }, token);
    const up = await FileSystem.uploadAsync(startJson.upload_url, uri, {
      httpMethod: 'PUT', headers: { 'Content-Type': 'audio/mp4', 'x-upsert': 'false' },
    });
    if (up.status < 200 || up.status >= 300) throw new Error(`Upload geweigerd (${up.status})`);
    await ingest('complete', {
      recording_id: startJson.recording_id, ended_at: new Date().toISOString(), duration_seconds: duration,
      consent_status: 'informed', consent_method: 'app_notice',
      consent_details: 'Staande consent-bevestiging in de mobiele app.',
    }, token);
  }

  async function retryUpload() {
    const p = pendingUpload.current; if (!p) return;
    setPhase('uploading');
    try { await upload(p.uri, p.startedAt, p.duration); setPhase('done'); setMessage('Opname alsnog verstuurd.'); pendingUpload.current = null; }
    catch (e: any) { setPhase('failed'); setMessage(`Versturen mislukt: ${e.message}.`); }
  }

  const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');

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
      <Text style={styles.recHint}>Opname loopt — ook met het scherm uit.{'\n'}{TYPE_LABELS[recType]}</Text>
      <Pressable style={[styles.primary, styles.stop]} onPress={stopAndUpload}>
        <Text style={styles.primaryText}>Stop &amp; verstuur</Text>
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
      {phase === 'failed' && pendingUpload.current && (
        <Pressable style={styles.linkBtn} onPress={retryUpload}><Text style={styles.link}>Opnieuw versturen</Text></Pressable>
      )}
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

  error: { color: C.red, marginTop: 16, textAlign: 'center', lineHeight: 19 },
  success: { color: C.green, marginTop: 16, textAlign: 'center', lineHeight: 19 },
  linkBtn: { marginTop: 24, alignItems: 'center' },
  link: { color: C.muted, fontSize: 13, textDecorationLine: 'underline' },
});
