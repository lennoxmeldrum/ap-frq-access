/**
 * One-shot migration: bring every AP PCM doc under `subject: "appcm"`.
 *
 * Two pre-existing situations in the `frqs` collection:
 *
 *   1. Docs stamped `subject: "physics"` by the original backfill
 *      (`backfill-frq-subjects.ts`). That slug was ambiguous — AP has
 *      four Physics courses (Physics 1, 2, C: Mechanics, C: E&M) —
 *      so it's being tightened to `"appcm"`, matching the generator
 *      repo name and the apbio / apchem / appsych convention.
 *
 *   2. PCM docs generated between the original backfill run and the
 *      generator itself starting to write `subject` natively
 *      (lennoxmeldrum/appcm-infinite-frq-generator#51). Those docs
 *      have no `subject` field at all. Identified conservatively via
 *      `storagePath` prefix OR `metadata.frqTypeShort` ∈ PCM's four
 *      type codes, so apbio/apchem/appsych docs are never touched.
 *
 * Usage
 * -----
 * Same click-path as `backfill-frq-subjects.ts`. Cloud Build trigger
 * pointed at a new `cloudbuild.pcm-to-appcm.yaml` (copy the existing
 * backfill yaml and swap the script path). Grant the Cloud Build
 * service account "Cloud Datastore User". Run with
 * `_DRY_RUN=--dry-run` first; re-run without the override to commit.
 * Delete the trigger AND this file after verification.
 *
 * Safety
 * ------
 * - Never rewrites a doc that already claims a different subject —
 *   a doc tagged `"apbio"` stays `"apbio"`, full stop. PCM inference
 *   only runs when `subject` is missing/empty.
 * - Only writes the `subject` field; `storagePath`, `metadata`,
 *   `usage`, etc. are left alone.
 * - Idempotent: a second run finds zero candidates and no-ops.
 */

import admin from 'firebase-admin';

const TARGET_SUBJECT = 'appcm';
const STORAGE_PREFIX = 'AP PCM FRQ';
const PCM_TYPE_SHORTS = new Set(['MR', 'TBR', 'LAB', 'QQT']);

// Subject values that mean "this is an AP PCM doc but the slug is
// stale and should be rewritten to TARGET_SUBJECT regardless of
// storagePath / frqTypeShort". The original backfill put all legacy
// PCM docs under "physics".
const STALE_PCM_SUBJECTS = new Set(['physics']);

// Only used when `subject` is missing or empty. Never reclassifies a
// doc that already claims some other subject.
const looksLikePcm = (data: FirebaseFirestore.DocumentData): boolean => {
  const storagePath: unknown = data.storagePath;
  if (typeof storagePath === 'string') {
    const basename = storagePath.replace(/^frq-archive\//, '');
    if (basename.startsWith(STORAGE_PREFIX)) return true;
  }
  const short: unknown = data?.metadata?.frqTypeShort;
  if (typeof short === 'string' && PCM_TYPE_SHORTS.has(short)) return true;
  return false;
};

type Action =
  | { kind: 'rewrite-stale'; from: string }
  | { kind: 'backfill-missing' };

const main = async () => {
  const isDryRun = process.argv.includes('--dry-run');

  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });

  const db = admin.firestore();
  const collectionRef = db.collection('frqs');

  console.log(`${isDryRun ? '[DRY RUN] ' : ''}Scanning frqs collection…`);
  const snapshot = await collectionRef.get();
  console.log(`Found ${snapshot.size} total docs.`);

  const updates: Array<{ id: string; action: Action }> = [];
  const stats = {
    alreadyAppcm: 0,
    rewriteStale: 0,
    backfillMissing: 0,
    leftAlone: 0,
  };

  for (const doc of snapshot.docs) {
    const data = doc.data();
    const subject: unknown = data.subject;

    if (subject === TARGET_SUBJECT) {
      stats.alreadyAppcm += 1;
      continue;
    }

    if (typeof subject === 'string' && STALE_PCM_SUBJECTS.has(subject)) {
      updates.push({
        id: doc.id,
        action: { kind: 'rewrite-stale', from: subject },
      });
      stats.rewriteStale += 1;
      continue;
    }

    const subjectIsEmpty =
      subject === undefined || subject === null || subject === '';
    if (subjectIsEmpty && looksLikePcm(data)) {
      updates.push({ id: doc.id, action: { kind: 'backfill-missing' } });
      stats.backfillMissing += 1;
      continue;
    }

    stats.leftAlone += 1;
  }

  console.log('');
  console.log('Summary:');
  console.log(`  Already "${TARGET_SUBJECT}":                ${stats.alreadyAppcm}`);
  console.log(`  Rewriting stale → "${TARGET_SUBJECT}":     ${stats.rewriteStale}`);
  console.log(`  Backfilling missing → "${TARGET_SUBJECT}": ${stats.backfillMissing}`);
  console.log(`  Left alone (other subjects):     ${stats.leftAlone}`);
  console.log(`  Total to update:                 ${updates.length}`);
  console.log('');

  if (isDryRun) {
    for (const { id, action } of updates) {
      const desc =
        action.kind === 'rewrite-stale'
          ? `rewrite from "${action.from}"`
          : `backfill missing subject`;
      console.log(`  [DRY RUN] ${id}  ${desc}`);
    }
    console.log('Dry run complete. No docs were modified.');
    return;
  }

  if (updates.length === 0) {
    console.log('Nothing to update.');
    return;
  }

  const BATCH_SIZE = 400;
  for (let i = 0; i < updates.length; i += BATCH_SIZE) {
    const chunk = updates.slice(i, i + BATCH_SIZE);
    const batch = db.batch();
    for (const { id } of chunk) {
      batch.update(collectionRef.doc(id), { subject: TARGET_SUBJECT });
    }
    await batch.commit();
    console.log(`  Committed batch ${i / BATCH_SIZE + 1}: ${chunk.length} docs.`);
  }

  console.log('');
  console.log(`Migration complete: ${updates.length} docs updated to "${TARGET_SUBJECT}".`);
};

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
