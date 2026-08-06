# App Review Information — paste into App Store Connect

> Field "App Review Information → Notes". Written in English for the reviewer.
> Turn ON "Sign-in required" and fill the demo account below.

## Demo account (create this in the Capture project before submitting)
- **Username:** `<REVIEWER_EMAIL>`  ← e.g. review@salesup.be
- **Password:** `<REVIEWER_PASSWORD>`  ← set your own; fill it in here (do not commit it)

> Stig: create this as a real member in the salesUp Capture Supabase project so the reviewer can log in. Give it access to a demo organization with at least one processed recording so the history screen isn't empty.

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
