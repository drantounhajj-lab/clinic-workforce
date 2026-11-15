# Clinic Workforce — mobile app (iPhone, Android, iPad kiosk)

Expo / React Native app, SDK 57. Version 0.1: punch-in tests at the clinics, with sample staff and schedules. Nothing is sent to a server yet; punches stay on each device.

## What it does

- **Clock in / out by location:** real GPS, checked against the clinic's zone (100, 150 or 250 m). If the phone is on a registered clinic Wi-Fi, an out-of-zone GPS reading is still accepted, with a flag. Fake-location apps are refused (Android detects them; iOS detection is limited).
- **Clock in / out by QR:** the clinic iPad runs this same app in kiosk mode and shows a QR code that changes every 30 seconds. Staff scan it with their phone. A photo of an old code is refused.
- **Kiosk PIN pad** on the iPad.
- **Schedule** with confirm / decline (sample data).
- **Setup:** pick who you are (until logins exist), save each clinic's real location and Wi-Fi while standing inside it, choose the zone size, start kiosk mode.
- French and English (follows the phone's language; can be changed in Setup).

Shared logic comes from `../../packages` (time clock checks, labour rules, sample data) through `metro.config.js`.

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

You need: an Apple Developer account (US$99/year), a free Expo account (expo.dev), Node.js 22+ on your computer. No Mac needed: Expo builds the app in the cloud.

1. Get the code and install packages:
   ```bash
   git clone https://github.com/drantounhajj-lab/clinic-workforce.git
   cd clinic-workforce/apps/mobile
   npm install
   ```
2. Log in to Expo: `npx eas-cli@latest login`
3. Link the project the first time: `npx eas-cli@latest init`
4. Build for iPhone: `npx eas-cli@latest build --platform ios --profile production`
   EAS asks for your Apple Developer login and creates the certificates for you.
5. Send it to TestFlight: `npx eas-cli@latest submit --platform ios --latest`
6. In App Store Connect → TestFlight, add testers by email. Internal testers (people on your App Store Connect team) get it right away; external testers need a short Apple beta review first.
7. Testers install Apple's TestFlight app, accept the invite, then install Clinic Workforce.

The bundle identifier is `com.drantounhajj.clinicworkforce` in `app.json`. Change it before the first build if you want a different one; it can't be changed in the App Store afterwards.

## Install on Android

`npx eas-cli@latest build --platform android --profile preview` produces an APK link. Staff open it on their phone to install (they may need to allow installs from that source). Google Play internal testing comes later.

## Testing at the clinics

1. On each phone: Setup → pick the employee.
2. Once per clinic, on one phone standing inside the clinic: Setup → "Use my location here", then "Add current Wi-Fi". Repeat on other phones (settings are per device until the backend exists).
3. Try clocking in inside, in the parking lot and across the street to tune the zone size.
4. On the iPad: Setup → "Start kiosk mode". Staff scan its code from the Clock screen. Hold the clinic name for 2 seconds to exit.

## Not yet

- Server, logins, real schedules: punches stay on the device.
- QR codes are signed with a demo secret in the app; the server will sign them.
- Photo at punch, NFC, availability and time-off screens.
