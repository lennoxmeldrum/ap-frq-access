/**
 * Manual one-shot to rebuild every per-subject manifest JSON in
 * Firebase Storage. Used to bootstrap the manifests after first
 * deploying the Cloud Function (no docs have been written since
 * deploy → no manifest exists yet → access site silently falls back
 * to per-page Firestore queries forever), and to repair manifests
 * after a Firestore restore.
 *
 * Why a script and not a one-liner Cloud Function call:
 *   The rebuild logic lives in functions/src/index.ts and uses the
 *   same firebase-admin SDK this script uses. We deliberately don't
 *   import from there to avoid a path coupling between the two
 *   independently-deployed projects — copying the ~50 lines of
 *   manifest-building logic is the smaller cost.
 *
 * Usage (no CLI required)
 * -----------------------
 * Driven by the existing `cloudbuild.backfill.yaml` trigger. Set:
 *   _BACKFILL_SCRIPT=scripts/rebuild-all-manifests.ts
 *   _DRY_RUN=                                       (no flag, real run)
 *
 * The script reads the SUBJECTS list from constants.ts (importing it
 * via a relative path is fine — Cloud Build runs `npx tsx` which
 * supports TS imports of TS files transparently).
 */

import admin from 'firebase-admin';

import { SUBJECTS } from '../constants';

const FRQS_COLLECTION = 'frqs';
const MANIFEST_PATH = (subject: string) =>
  `frq-archive/manifests/${subject}.json`;
const MANIFEST_VERSION = 1;

interface ManifestItem {
  id: string;
  maxPoints: number | null;
  metadata: {
    frqType: string;
    frqTypeShort: string;
    selectedUnits: (string | number)[];
    selectedSubTopics: string[];
    actualSubTopics: string[];
    wasRandom: boolean;
  };
  storagePath: string | null;
  createdAt: string | null;
}

const toISODate = (value: unknown): string | null => {
  if (!value) return null;
  if (value instanceof admin.firestore.Timestamp) return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  return null;
};

const mapDocToManifestItem = (
  id: string,
  data: FirebaseFirestore.DocumentData
): ManifestItem => {
  const metadata = (data.metadata ?? {}) as Record<string, unknown>;
  return {
    id,
    maxPoints: typeof data.maxPoints === 'number' ? (data.maxPoints as number) : null,
    metadata: {
      frqType: (metadata.frqType as string) ?? '',
      frqTypeShort: (metadata.frqTypeShort as string) ?? '',
      selectedUnits: (metadata.selectedUnits as (string | number)[]) ?? [],
      selectedSubTopics: (metadata.selectedSubTopics as string[]) ?? [],
      actualSubTopics: (metadata.actualSubTopics as string[]) ?? [],
      wasRandom: Boolean(metadata.wasRandom),
    },
    storagePath: (data.storagePath as string | null | undefined) ?? null,
    createdAt: toISODate(data.createdAt),
  };
};

const rebuildSubject = async (subject: string): Promise<number> => {
  const db = admin.firestore();
  const snapshot = await db
    .collection(FRQS_COLLECTION)
    .where('subject', '==', subject)
    .orderBy('createdAt', 'desc')
    .get();

  const items = snapshot.docs.map((doc) => mapDocToManifestItem(doc.id, doc.data()));
  const distinctFrqTypes = Array.from(
    new Set(
      items
        .map((i) => i.metadata.frqTypeShort)
        .filter((s): s is string => typeof s === 'string' && s.length > 0)
    )
  ).sort();

  const manifest = {
    subject,
    manifestVersion: MANIFEST_VERSION,
    generatedAt: new Date().toISOString(),
    count: items.length,
    distinctFrqTypes,
    items,
  };

  const bucket = admin.storage().bucket();
  const file = bucket.file(MANIFEST_PATH(subject));
  await file.save(JSON.stringify(manifest), {
    contentType: 'application/json',
    metadata: {
      cacheControl: 'public, max-age=30, must-revalidate',
    },
    resumable: false,
  });

  return items.length;
};

const main = async () => {
  const isDryRun = process.argv.includes('--dry-run');
  if (isDryRun) {
    console.log('[DRY RUN] No manifests will be written.');
  }

  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || undefined,
  });

  for (const subject of SUBJECTS) {
    const slug = subject.slug;
    if (isDryRun) {
      const db = admin.firestore();
      const snap = await db
        .collection(FRQS_COLLECTION)
        .where('subject', '==', slug)
        .count()
        .get();
      console.log(`  ${slug}: would write ${snap.data().count} items`);
      continue;
    }
    try {
      const n = await rebuildSubject(slug);
      console.log(`  ${slug}: wrote manifest with ${n} items`);
    } catch (err) {
      console.error(`  ${slug}: FAILED:`, err);
    }
  }

  console.log('');
  console.log(isDryRun ? 'Dry run complete.' : 'Manifest rebuild complete.');
};

main().catch((err) => {
  console.error('Rebuild failed:', err);
  process.exit(1);
});
