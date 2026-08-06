# App Privacy (iOS) + Data safety (Android) — antwoorden

Truthful mapping van wat de app verzamelt. Kern: **account-gegevens + opnames/transcripts**, gekoppeld aan de gebruiker, **enkel voor app-functionaliteit** (kwaliteit/training). **Geen tracking, geen advertenties, niet verkocht.**

## Verwerkers (service providers, onder DPA — geen data-brokers)
- **Deepgram** — transcriptie (spraak → tekst)
- **Anthropic (Claude)** — samenvatting/scoring
- **Recall.ai** — videocall-opname (meeting-route)
- **Supabase** — database + opslag (EU-regio)
- **Resend** — e-mail (verslagen/uitnodigingen)

→ In Apple's definitie tellen dit als *service providers die namens jou verwerken*, niet als "data sharing" voor eigen doeleinden. Antwoord op "shared with third parties": **No** (enkel service providers). Wel eerlijk vermelden in de privacy policy.

## iOS — App Privacy (per datatype: Collected? Linked to user? Used for tracking? Purpose)

| Datatype | Collected | Linked | Tracking | Purpose |
|---|---|---|---|---|
| **Contact Info → Email address** | Ja | Ja | Nee | App Functionality (account/login) |
| **User Content → Audio Data** (opnames) | Ja | Ja | Nee | App Functionality |
| **User Content → Other User Content** (transcripts, samenvattingen, notities) | Ja | Ja | Nee | App Functionality |
| **Identifiers → User ID** | Ja | Ja | Nee | App Functionality |
| **Identifiers → Device ID** (push-token) | Ja | Ja | Nee | App Functionality (meldingen) |

- Alle andere categorieën (Location, Contacts, Browsing, Financial, Health, Usage Data, Diagnostics via derde-partij-SDK): **niet verzameld**.
- "Used to track you": **Nee** overal → geen ATT-prompt nodig.

## Android — Data safety (Play Console)

- **Data collected:** Personal info (e-mail), Audio (opnames/spraak), App activity/User content (transcripts), App info (push-identifier).
- **Encrypted in transit:** Ja.
- **Users can request data deletion:** Ja (via beheerder/support — beschrijf in policy).
- **Data shared with third parties:** Nee (enkel service providers onder contract).
- **Collection required or optional:** vereist voor kernfunctie (opname).
- **Doel:** App functionality (+ account management).

## Belangrijk
- Microfoon/opname enkel **na expliciete gebruikersactie** + consent-banner → benadruk dit.
- Zorg dat de **privacy policy** exact deze datatypes + verwerkers benoemt (stores kruischecken policy ↔ questionnaire).
