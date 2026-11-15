# Clinic Workforce — mobile app (iPhone, Android, iPad kiosk)

Expo / React Native app, SDK 57. Version 0.2: connected to the Supabase backend. Staff sign in with an email code, see their published shifts, and punch in. Every punch is checked and stored on the server.

## What it does

- **Sign in with an email code.** No passwords and no "pick who you are". Only people a manager added (in the manager web page) can use the app; anyone else sees "not invited".
- **Clock in / out by location:** phone GPS sent to the server, which checks the clinic's zone and refuses fake-location apps. If the phone is on a registered clinic Wi-Fi, an out-of-zone reading is still accepted, with a flag. Too early before a shift is refused.
- **Clock in / out by QR:** the clinic iPad shows a code that changes every 30 seconds, signed by the server. Staff scan it from the Clock screen.
- **Schedule:** published shifts for the clinics you work at, with confirm / decline.
- **Setup:** language, sign out, your personal 4–6 digit PIN for the clinic iPad.
- **Manager tools** (clinic managers and owners only): save a clinic's real location and its Wi-Fi while standing inside it.
- **Clinic iPad (kiosk):** "Set up this device as a clinic iPad" on the sign-in screen shows a pairing code. A manager enters it in the manager web page (Kiosks) to attach the iPad to a clinic. The iPad then shows the rotating QR code and a PIN pad. Hold the clinic name for 3 seconds to leave kiosk mode.
- French and English.

Shared logic comes from `../../packages` (time clock, labour rules) through `metro.config.js`.

## Backend settings this app needs (Supabase dashboard)

1. Authentication → Sign In / Providers → **Allow anonymous sign-ins: on** (used only by the clinic iPads).
2. Authentication → Emails → **Magic Link** template body: `<p>Votre code / Your code: <strong>{{ .Token }}</strong></p>` so the email shows a 6-digit code.
3. Before inviting staff outside your Supabase team: Authentication → Emails → **SMTP settings** with a real email provider. The built-in sender only delivers to team members and is rate-limited.

## Develop

```bash
cd apps/mobile
npm install
npm run typecheck
npm run lint
npx expo start   # then open in a development build
```

This app uses native modules (camera, location, Wi-Fi info), so it needs a development or release build, not Expo Go.

## Install on iPhones with TestFlight

You need: an Apple Developer account (US$99/year), a free Expo account (expo.dev), Node.js 22+ on your computer. Expo builds the app in the cloud.

1. Get the code and install packages:
   ```bash
   git clone https://github.com/drantounhajj-lab/clinic-workforce.git
   cd clinic-workforce/apps/mobile
   npm install
   ```
   Already have it? `cd clinic-workforce && git pull && cd apps/mobile && npm install`
2. Log in to Expo: `npx eas-cli@latest login`
3. First time only: `npx eas-cli@latest init`
4. Build: `npx eas-cli@latest build --platform ios --profile production`
5. Send to TestFlight: `npx eas-cli@latest submit --platform ios --latest`
6. In App Store Connect → TestFlight, add testers by email. Internal testers get it right away; external testers need a short Apple beta review first.
7. Testers install Apple's TestFlight app, accept the invite, then install Clinic Workforce.

The bundle identifier is `com.drantounhajj.clinicworkforce` in `app.json`.

## Install on Android

`npx eas-cli@latest build --platform android --profile preview` produces an APK link. Google Play internal testing comes later.

## Not yet

- Offline punch queue (today the app says "no connection" and does not punch).
- Photo at punch, NFC, availability and time-off screens.
