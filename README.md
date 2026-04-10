# ap-frq-access

Read-only web app for browsing and downloading PDFs from the shared
Firebase archive built by the AP Infinite FRQ Generators (Physics C:
Mechanics, Chemistry, Psychology, and future subjects).

This app does not generate or grade FRQs — it only reads the `frqs`
Firestore collection and the `frq-archive/` Storage folder used by the
generators.

## Stack

- React 19 + Vite 6 + TypeScript
- Tailwind CSS via the CDN loader (same pattern as the generators)
- Firebase JS SDK (`firebase/app`, `firebase/auth`, `firebase/firestore`,
  `firebase/storage`)
- `react-router-dom` for `/` and `/subject/:subject`
- Deploys to Cloud Run via `cloudbuild.yaml` (same Dockerfile /
  entrypoint pattern as the generators)

## Local development

```bash
npm install
npm run dev
```

Local dev reads Firebase config from `VITE_FIREBASE_*` env vars:

```
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_STORAGE_BUCKET=...
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
```

In production (Cloud Run), these are injected at container start by
`docker-entrypoint.sh` writing `runtime-config.js` before nginx starts.

## Deployment

Pushing to the `main` (or whichever branch is wired to the Cloud Build
trigger) triggers `cloudbuild.yaml`, which builds the Docker image,
pushes it to Artifact Registry, and deploys to Cloud Run as the
`ap-frq-access` service. The trigger supplies the following substitution
variables:

- `_FIREBASE_API_KEY`
- `_FIREBASE_AUTH_DOMAIN`
- `_FIREBASE_PROJECT_ID`
- `_FIREBASE_STORAGE_BUCKET`
- `_FIREBASE_MESSAGING_SENDER_ID`
- `_FIREBASE_APP_ID`

Unlike the generators, this service does **not** need the `FRQ` Gemini
API key secret binding.

## Security rules

`firestore.rules` and `storage.rules` lock the archive to read-only for
all clients and create-only (not update / delete) for the generators.
Deploy with:

```bash
firebase deploy --only firestore:rules,storage
firebase deploy --only firestore:indexes
```

## One-time backfill

`scripts/backfill-subject-field.ts` adds the `subject` field to legacy
FRQ docs written before the generators started stamping `subject`
themselves. See the header comment in the script for usage. Run it once
after deploying the rules and generator updates, verify counts, then
delete the script.

## Adding a new subject

1. Ship a new generator repo that writes `subject: '<slug>'` on every
   FRQ doc it creates.
2. Add a new entry to `SUBJECTS` in `constants.ts` with a display name,
   colors, and storage prefix.
3. (Optional) If the new subject was live before adding `subject`, adapt
   the backfill script to cover it.
