// Publieke configuratie — de anon key is by design publiek (RLS beschermt de
// data); er staan géén geheimen in de app. Alle schrijfacties lopen via de
// ingest-recording edge function die de gebruikers-JWT server-side valideert
// en de klant-scope afdwingt.
export const SUPABASE_URL = 'https://plbuczbxtauhuobkicdr.supabase.co';
export const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBsYnVjemJ4dGF1aHVvYmtpY2RyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExNjA1NTcsImV4cCI6MjA5NjczNjU1N30.5hIzTuUvHYYxfnGxjM0IZmOxLwB0pDlo9_HCTsVcO-I';
export const INGEST_URL = `${SUPABASE_URL}/functions/v1/ingest-recording`;

export const BRAND = {
  blueDark: '#1a2540',
  orange: '#FF6B35',
  ghost: '#f4f5f7',
};
