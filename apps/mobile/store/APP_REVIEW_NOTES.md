# App Review Information — paste into App Store Connect

> Field "App Review Information → Notes". Written in English for the reviewer.
> Turn ON "Sign-in required" and fill the demo account below.

## Demo account
- **Username:** `review@salesup.be`  ← al aangemaakt (geïsoleerde org "salesUp Demo (App Review)", geen echte klantdata)
- **Password:** `<VUL_IN>`  ← zet je zelf (zie hieronder); vul hier in bij het indienen, commit het NIET

> Het account bestaat al in het Capture-project (e-mail bevestigd, member=owner van een lege demo-org). **Zet enkel nog het wachtwoord** door dit één keer te draaien in de Supabase SQL-editor van het Capture-project (`plbuczbxtauhuobkicdr`):
> ```sql
> UPDATE auth.users
> SET encrypted_password = crypt('KIES-EEN-STERK-WACHTWOORD', gen_salt('bf'))
> WHERE email = 'review@salesup.be';
> ```
> De reviewer test door zélf een korte opname te maken (de historiek is bewust leeg = geen klant-PII).

## Review notes (paste as-is)
```
salesUp Capture is a business tool for sales teams. After the user EXPLICITLY taps
"Record", the app records the audio of an in-person sales conversation (or joins a
video meeting via a visible bot) so the company can review it for internal quality
and coaching purposes. Recording never starts automatically or silently — it is
always user-initiated, and a consent banner is shown.

How to test:
1. Log in with the demo account above.
2. On the home screen, tap the large "Record" button and allow microphone access.
3. Speak for ~10 seconds, then tap Stop. The recording uploads and is processed
   (transcript + summary). It then appears in the history list.
4. (Optional) The app can also send a reminder notification shortly before a
   scheduled external meeting; this is a standard local/push reminder.

Notes:
- Microphone: used only during a user-initiated recording (NSMicrophoneUsageDescription).
- Background audio mode: allows an in-progress recording to continue if the screen
  locks during a long conversation. It is NOT used to record without user action.
- Notifications: optional reminders to start a recording before a meeting.
- All data is tied to the authenticated business user; no advertising, no tracking.
Contact for questions: <SUPPORT_EMAIL>
```

## Also fill in App Store Connect
- **Contact info:** first/last name, phone, email of a person Apple can reach.
- **Support URL** and **Marketing URL** (can be salesup.be).
