// Expo config-plugin: verwijdert de FOREGROUND_SERVICE_MEDIA_PLAYBACK-permissie
// en het 'mediaPlayback'-foregroundServiceType uit het Android-manifest.
//
// Waarom: salesUp Capture NEEMT enkel op (microfoon) en speelt geen media af.
// expo-audio voegt bij het bouwen standaard een media-playback-foreground-
// service toe; die gebruiken we niet, en Google Play vraagt er anders een
// (onterechte) demonstratievideo voor. We houden enkel FOREGROUND_SERVICE_MICROPHONE.
const { withAndroidManifest } = require('@expo/config-plugins');

const MEDIA_PB = 'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK';

module.exports = function withoutMediaPlaybackFgs(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;

    // 1) uses-permission FOREGROUND_SERVICE_MEDIA_PLAYBACK verwijderen
    if (Array.isArray(manifest['uses-permission'])) {
      manifest['uses-permission'] = manifest['uses-permission'].filter(
        (p) => p?.$?.['android:name'] !== MEDIA_PB,
      );
    }

    // 2) 'mediaPlayback' weghalen uit elk service-foregroundServiceType (microphone behouden)
    const app = (manifest.application || [])[0];
    if (app && Array.isArray(app.service)) {
      for (const svc of app.service) {
        const type = svc?.$?.['android:foregroundServiceType'];
        if (type && type.includes('mediaPlayback')) {
          const kept = type
            .split('|')
            .map((s) => s.trim())
            .filter((s) => s && s !== 'mediaPlayback')
            .join('|');
          if (kept) svc.$['android:foregroundServiceType'] = kept;
          else delete svc.$['android:foregroundServiceType'];
        }
      }
    }

    return cfg;
  });
};
