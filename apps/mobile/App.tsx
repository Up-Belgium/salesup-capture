// salesUp Capture — mobiele app (fase 3, MVP)
// Opnemen van fysieke meetings en telefoongesprekken-op-speaker, met upload
// naar de capture-pipeline (transcriptie + AI-analyse volgen automatisch).
//
// Bewuste keuzes:
// - Login met het bestaande platform-account (Supabase Auth). De app bevat
//   géén geheimen; de ingest-recording edge function valideert de JWT en
//   dwingt de klant-scope server-side af.
// - Opnemen start altijd met een expliciete tik + consent-bevestiging
//   (GDPR: gesprekspartners geïnformeerd). Eenmaal gestart loopt de opname
//   door op de achtergrond (UIBackgroundModes audio / foreground service).
// - Mislukte uploads blijven lokaal staan en kunnen opnieuw verstuurd worden.

import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable,
  ScrollView, StyleSheet, Switch, Text, TextInput, View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system';
import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, Session } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY, INGEST_URL, BRAND } from './src/config';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

type Ctx = {
  role: string;
  participant_id: string | null;
  orgs: { id: string; name: string }[];
};

type RecordingType = 'in_person' | 'phone' | 'video_meeting';

const TYPE_LABELS: Record<RecordingType, string> = {
  in_person: 'Fysieke meeting',
  phone: 'Telefoon (speaker)',
  video_meeting: 'Videocall',
};

async function ingest(action: string, body: Record<string, unknown>, token: string) {
  const res = await fetch(INGEST_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
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
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setBooting(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (booting) {
    return (
      <View style={[styles.screen, styles.center]}>
        <ActivityIndicator color={BRAND.orange} size="large" />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      {session ? <Recorder session={session} /> : <Login />}
    </View>
  );
}

// ── Login ────────────────────────────────────────────────────────────────────
function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    setBusy(true);
    setError('');
    const { error: err } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (err) setError('Inloggen mislukt — controleer e-mail en wachtwoord.');
    setBusy(false);
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.center}>
      <Text style={styles.logo}>
        sales<Text style={{ color: BRAND.orange }}>Up</Text> Capture
      </Text>
      <Text style={styles.subtitle}>Log in met je trainingsplatform-account</Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <TextInput
        style={styles.input} placeholder="E-mailadres" placeholderTextColor="#8a93a6"
        autoCapitalize="none" keyboardType="email-address" value={email} onChangeText={setEmail}
      />
      <TextInput
        style={styles.input} placeholder="Wachtwoord" placeholderTextColor="#8a93a6"
        secureTextEntry value={password} onChangeText={setPassword}
      />
      <Pressable style={[styles.button, busy && styles.buttonDisabled]} onPress={submit} disabled={busy}>
        <Text style={styles.buttonText}>{busy ? 'Bezig…' : 'Inloggen'}</Text>
      </Pressable>
    </KeyboardAvoidingView>
  );
}

// ── Recorder ─────────────────────────────────────────────────────────────────
function Recorder({ session }: { session: Session }) {
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [ctxError, setCtxError] = useState('');
  const [clientId, setClientId] = useState('');
  const [recType, setRecType] = useState<RecordingType>('in_person');
  const [title, setTitle] = useState('');
  const [consent, setConsent] = useState(false);

  const [recording, setRecording] = useState<Audio.Recording | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [phase, setPhase] = useState<'idle' | 'recording' | 'uploading' | 'done' | 'failed'>('idle');
  const [message, setMessage] = useState('');
  const pendingUpload = useRef<{ uri: string; startedAt: string; duration: number } | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const json = await ingest('context', {}, session.access_token);
        setCtx(json);
        if (json.orgs?.length === 1) setClientId(json.orgs[0].id);
      } catch (e: any) {
        setCtxError(
          e.message === 'unauthorized'
            ? 'Geen toegang — dit account is niet gekoppeld aan het trainingsplatform.'
            : `Kon profiel niet laden: ${e.message}`
        );
      }
    })();
  }, [session.access_token]);

  async function start() {
    if (!consent) {
      Alert.alert('Consent vereist', 'Bevestig eerst dat de gesprekspartners geïnformeerd zijn over deze opname.');
      return;
    }
    if (!clientId) {
      Alert.alert('Kies een klant', 'Selecteer voor welke klant deze opname is.');
      return;
    }
    const perm = await Audio.requestPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Microfoon vereist', 'Geef de app toegang tot de microfoon om te kunnen opnemen.');
      return;
    }
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
      staysActiveInBackground: true,
      shouldDuckAndroid: true,
    });
    const { recording: rec } = await Audio.Recording.createAsync(
      Audio.RecordingOptionsPresets.HIGH_QUALITY
    );
    setRecording(rec);
    setSeconds(0);
    setPhase('recording');
    setMessage('');
    pendingUpload.current = null;
    timer.current = setInterval(() => setSeconds((s) => s + 1), 1000);
  }

  async function stopAndUpload() {
    if (!recording) return;
    if (timer.current) clearInterval(timer.current);
    setPhase('uploading');
    let uri = '';
    try {
      await recording.stopAndUnloadAsync();
      uri = recording.getURI() ?? '';
      setRecording(null);
      if (!uri) throw new Error('Geen opnamebestand gevonden.');
      const startedAt = new Date(Date.now() - seconds * 1000).toISOString();
      pendingUpload.current = { uri, startedAt, duration: seconds };
      await upload(uri, startedAt, seconds);
      setPhase('done');
      setMessage('Opname verstuurd. Transcriptie en analyse volgen automatisch in het dashboard.');
      setConsent(false);
      setTitle('');
      pendingUpload.current = null;
    } catch (e: any) {
      setPhase('failed');
      setMessage(`Versturen mislukt: ${e.message}. De opname staat nog op dit toestel — probeer opnieuw.`);
    }
  }

  async function upload(uri: string, startedAt: string, duration: number) {
    // Token kan verlopen zijn na een lange opname — altijd verse sessie vragen.
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error('Sessie verlopen — log opnieuw in.');

    const startJson = await ingest('start', {
      org_id: clientId,
      recording_type: recType,
      title: title || null,
      started_at: startedAt,
      ext: 'm4a',
    }, token);

    const up = await FileSystem.uploadAsync(startJson.upload_url, uri, {
      httpMethod: 'PUT',
      headers: { 'Content-Type': 'audio/mp4', 'x-upsert': 'false' },
    });
    if (up.status < 200 || up.status >= 300) {
      throw new Error(`Upload geweigerd (${up.status})`);
    }

    await ingest('complete', {
      recording_id: startJson.recording_id,
      ended_at: new Date().toISOString(),
      duration_seconds: duration,
      consent_status: 'informed',
      consent_method: 'app_notice',
      consent_details: 'Bevestigd in de mobiele app vóór de start van de opname.',
    }, token);
  }

  async function retryUpload() {
    const p = pendingUpload.current;
    if (!p) return;
    setPhase('uploading');
    try {
      await upload(p.uri, p.startedAt, p.duration);
      setPhase('done');
      setMessage('Opname alsnog verstuurd.');
      pendingUpload.current = null;
    } catch (e: any) {
      setPhase('failed');
      setMessage(`Versturen mislukt: ${e.message}.`);
    }
  }

  const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');

  if (ctxError) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>{ctxError}</Text>
        <Pressable style={styles.linkBtn} onPress={() => supabase.auth.signOut()}>
          <Text style={styles.link}>Uitloggen</Text>
        </Pressable>
      </View>
    );
  }
  if (!ctx) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={BRAND.orange} size="large" />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.logo}>
        sales<Text style={{ color: BRAND.orange }}>Up</Text> Capture
      </Text>

      {phase === 'recording' ? (
        <View style={styles.recordPanel}>
          <View style={styles.dot} />
          <Text style={styles.timer}>{mm}:{ss}</Text>
          <Text style={styles.recordHint}>
            Opname loopt — ook met het scherm uit. {'\n'}{TYPE_LABELS[recType]}
          </Text>
          <Pressable style={[styles.button, styles.stopButton]} onPress={stopAndUpload}>
            <Text style={styles.buttonText}>Stop & verstuur</Text>
          </Pressable>
        </View>
      ) : (
        <>
          {ctx.orgs.length > 1 && (
            <>
              <Text style={styles.label}>Klant</Text>
              <View style={styles.chips}>
                {ctx.orgs.map((c) => (
                  <Pressable key={c.id}
                    style={[styles.chip, clientId === c.id && styles.chipActive]}
                    onPress={() => setClientId(c.id)}>
                    <Text style={[styles.chipText, clientId === c.id && styles.chipTextActive]}>{c.name}</Text>
                  </Pressable>
                ))}
              </View>
            </>
          )}

          <Text style={styles.label}>Type gesprek</Text>
          <View style={styles.chips}>
            {(Object.keys(TYPE_LABELS) as RecordingType[]).map((t) => (
              <Pressable key={t}
                style={[styles.chip, recType === t && styles.chipActive]}
                onPress={() => setRecType(t)}>
                <Text style={[styles.chipText, recType === t && styles.chipTextActive]}>{TYPE_LABELS[t]}</Text>
              </Pressable>
            ))}
          </View>
          {recType === 'phone' && (
            <Text style={styles.note}>
              Telefoongesprekken: zet de speaker aan — iOS en Android laten apps niet
              rechtstreeks aan de belaudio. Voor automatische telefoonopname komt het
              zakelijke belnummer (fase 4).
            </Text>
          )}

          <Text style={styles.label}>Titel (optioneel)</Text>
          <TextInput
            style={styles.input} placeholder="bv. Demo-gesprek Acme NV" placeholderTextColor="#8a93a6"
            value={title} onChangeText={setTitle}
          />

          <View style={styles.consentRow}>
            <Switch value={consent} onValueChange={setConsent}
                    trackColor={{ true: BRAND.orange }} />
            <Text style={styles.consentText}>
              De gesprekspartner(s) zijn geïnformeerd dat dit gesprek wordt opgenomen
              voor kwaliteits- en trainingsdoeleinden.
            </Text>
          </View>

          {phase === 'uploading' ? (
            <View style={[styles.button, styles.buttonDisabled]}>
              <ActivityIndicator color="#fff" />
            </View>
          ) : (
            <Pressable
              style={[styles.button, (!consent || !clientId) && styles.buttonDisabled]}
              onPress={start}>
              <Text style={styles.buttonText}>● Start opname</Text>
            </Pressable>
          )}

          {message ? (
            <Text style={phase === 'failed' ? styles.error : styles.success}>{message}</Text>
          ) : null}
          {phase === 'failed' && pendingUpload.current && (
            <Pressable style={styles.linkBtn} onPress={retryUpload}>
              <Text style={styles.link}>Opnieuw versturen</Text>
            </Pressable>
          )}

          <Pressable style={styles.linkBtn} onPress={() => supabase.auth.signOut()}>
            <Text style={styles.link}>Uitloggen ({session.user.email})</Text>
          </Pressable>
        </>
      )}
    </ScrollView>
  );
}

// ── Stijl (salesUp huisstijl) ───────────────────────────────────────────────
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: BRAND.blueDark },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  container: { padding: 24, paddingTop: 72 },
  logo: { fontSize: 28, fontWeight: '700', color: '#fff', textAlign: 'center', marginBottom: 8 },
  subtitle: { color: '#aab2c5', textAlign: 'center', marginBottom: 24 },
  label: { color: '#aab2c5', fontSize: 12, textTransform: 'uppercase', letterSpacing: 1, marginTop: 20, marginBottom: 8 },
  input: {
    backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 10, color: '#fff',
    paddingHorizontal: 14, paddingVertical: 12, marginBottom: 10, width: '100%', minWidth: 280,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.25)', borderRadius: 999,
    paddingHorizontal: 14, paddingVertical: 8,
  },
  chipActive: { backgroundColor: BRAND.orange, borderColor: BRAND.orange },
  chipText: { color: '#cfd5e1', fontSize: 13 },
  chipTextActive: { color: '#fff', fontWeight: '600' },
  note: { color: '#aab2c5', fontSize: 12, marginTop: 10, lineHeight: 17 },
  consentRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 24 },
  consentText: { color: '#cfd5e1', fontSize: 13, flex: 1, lineHeight: 18 },
  button: {
    backgroundColor: BRAND.orange, borderRadius: 12, paddingVertical: 16,
    alignItems: 'center', marginTop: 24, width: '100%', minWidth: 280,
  },
  buttonDisabled: { opacity: 0.45 },
  stopButton: { backgroundColor: '#d83a3a' },
  buttonText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  recordPanel: { alignItems: 'center', marginTop: 64 },
  dot: { width: 18, height: 18, borderRadius: 9, backgroundColor: '#d83a3a', marginBottom: 16 },
  timer: { color: '#fff', fontSize: 56, fontVariant: ['tabular-nums'], fontWeight: '200' },
  recordHint: { color: '#aab2c5', textAlign: 'center', marginTop: 12, lineHeight: 20 },
  error: { color: '#ff9d8f', marginTop: 16, textAlign: 'center', lineHeight: 19 },
  success: { color: '#8fd9a8', marginTop: 16, textAlign: 'center', lineHeight: 19 },
  linkBtn: { marginTop: 28, alignItems: 'center' },
  link: { color: '#8a93a6', fontSize: 13, textDecorationLine: 'underline' },
});
