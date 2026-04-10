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

## Security rules and indexes

`firestore.rules`, `storage.rules`, and `firestore.indexes.json` are
deployed automatically by the main `cloudbuild.yaml` on every Cloud
Build run. A final step in `cloudbuild.yaml` runs
`npx firebase-tools deploy --only firestore:rules,firestore:indexes,storage`
so whatever lives at HEAD is always what's live in the Firebase project.

**One-time IAM grant required:** the Cloud Build service account
(`<PROJECT_NUMBER>@cloudbuild.gserviceaccount.com`) needs these roles on
the Firebase project before the first build:

- **Firebase Rules Admin** — to publish Firestore + Storage rules
- **Cloud Datastore Index Admin** — to create the composite indexes

Grant both once in the Cloud Console → IAM & Admin → IAM page, and
every subsequent push auto-updates the rules and indexes.

### Manual fallback (no Cloud Build)

If you'd rather publish the rules by hand from the Firebase Console
instead of granting the IAM roles above, paste the contents of the
files into these places and click Publish:

- **Firestore rules** → Firestore Database → Rules tab ← `firestore.rules`
- **Storage rules** → Storage → Rules tab ← `storage.rules`
- **Firestore indexes** → either paste into Firestore → Indexes →
  Composite → Add index, or just visit the access site and click the
  auto-generated "create index" link Firestore prints in the browser
  console the first time a query needs it.

## One-time backfill

`scripts/backfill-subject-field.ts` adds the `subject` field to legacy
FRQ docs written before the generators started stamping `subject`
themselves. It is driven by `cloudbuild.backfill.yaml`, which is meant
to run as a **separate, manually-invoked** Cloud Build trigger — not on
every push.

Steps (UI only — no CLI):

1. In Cloud Console → Cloud Build → Triggers, create a new trigger
   `ap-frq-access-backfill`:
   - Event: **Manual invocation**
   - Source: this repo, any branch
   - Configuration: Cloud Build configuration file (yaml)
   - Location: Repository → `cloudbuild.backfill.yaml`
2. Grant the Cloud Build service account the **Cloud Datastore User**
   role on this project so it can read + update docs in `frqs`.
3. (Optional dry run) Click "Run trigger" and override the
   `_DRY_RUN` substitution to `--dry-run`. The build log will print
   how many docs would be updated per subject without writing.
4. Click "Run trigger" with no override to do the real backfill.
5. Verify the counts on each subject card on the deployed access site,
   then delete the trigger AND `scripts/backfill-subject-field.ts` and
   `cloudbuild.backfill.yaml` in a follow-up commit so this can never
   run again by accident.

## Adding a new subject

1. Ship a new generator repo that writes `subject: '<slug>'` on every
   FRQ doc it creates.
2. Add a new entry to `SUBJECTS` in `constants.ts` with a display name,
   colors, and storage prefix.
3. (Optional) If the new subject was live before adding `subject`, adapt
   the backfill script to cover it.
