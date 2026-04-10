/**
 * One-time backfill script for the `frqs` Firestore collection.
 *
 * Purpose
 * -------
 * Early versions of the three AP FRQ generators wrote docs to the shared
 * `frqs` collection without a `subject` field. The access site filters on
 * `subject`, so those legacy docs are invisible until we set it.
 *
 * This script reads every doc in `frqs`, infers the subject from the
 * `storagePath` prefix (the most reliable signal — `AP PCM FRQ`,
 * `AP CHEM FRQ`, `AP PSYCH FRQ`), and writes `subject` via a batched
 * update. Docs that already have a `subject` are left untouched.
 *
 * Usage (no CLI required)
 * -----------------------
 * Run this script as a one-shot Cloud Build trigger using
 * `cloudbuild.backfill.yaml` at the repo root. That config installs
 * firebase-admin + tsx inside a Cloud Build `node:20` step and executes
 * this file against the shared Firebase project using the Cloud Build
 * service account's default credentials (which is why we use
 * `admin.credential.applicationDefault()` below).
 *
 * Summary of the Cloud Build flow:
 *   1. Create a manual Cloud Build trigger pointing at
 *      `cloudbuild.backfill.yaml`.
 *   2. Grant the Cloud Build service account the "Cloud Datastore User"
 *      role so it can read and update docs in the `frqs` collection.
 *   3. (Optional) Click "Run trigger" with the substitution override
 *      `_DRY_RUN=--dry-run` to preview the changes without writing.
 *   4. Click "Run trigger" for the real run.
 *   5. Verify subject counts on the deployed access site, then delete
 *      the trigger AND this script so it can never run again by
 *      accident.
 *
 * See `cloudbuild.backfill.yaml` in the repo root for the exact
 * click-path and IAM requirements.
 */

import admin from 'firebase-admin';

type SubjectSlug = 'physics' | 'chemistry' | 'psychology';

interface PrefixRule {
  prefix: string;
  subject: SubjectSlug;
}

// Order matters only if prefixes overlap. These don't, but we leave the
// most specific ones first as a matter of habit.
const PREFIX_RULES: PrefixRule[] = [
  { prefix: 'AP PCM FRQ', subject: 'physics' },
  { prefix: 'AP CHEM FRQ', subject: 'chemistry' },
  { prefix: 'AP PSYCH FRQ', subject: 'psychology' },
];

// frqTypeShort fallback mapping — only used if storagePath is missing.
// These short codes are unique per subject in the current generators.
const FRQ_TYPE_SHORT_TO_SUBJECT: Record<string, SubjectSlug> = {
  // Physics C: Mechanics
  MR: 'physics',
  TBR: 'physics',
  LAB: 'physics',
  QQT: 'physics',
  // Chemistry
  Short: 'chemistry',
  Long: 'chemistry',
  // Psychology
  AAQ: 'psychology',
  EBQ: 'psychology',
};

const inferSubject = (data: FirebaseFirestore.DocumentData): SubjectSlug | null => {
  const storagePath: string | undefined = data.storagePath;
  if (typeof storagePath === 'string' && storagePath.length > 0) {
    // Storage paths look like `frq-archive/AP PSYCH FRQ - AAQ - ...pdf`.
    const basename = storagePath.replace(/^frq-archive\//, '');
    for (const rule of PREFIX_RULES) {
      if (basename.startsWith(rule.prefix)) return rule.subject;
    }
  }

  const short: string | undefined = data?.metadata?.frqTypeShort;
  if (typeof short === 'string' && FRQ_TYPE_SHORT_TO_SUBJECT[short]) {
    return FRQ_TYPE_SHORT_TO_SUBJECT[short];
  }

  return null;
};

const main = async () => {
  const isDryRun = process.argv.includes('--dry-run');

  // Initialize the Admin SDK. Relies on GOOGLE_APPLICATION_CREDENTIALS or
  // an attached service account when running on GCP.
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });

  const db = admin.firestore();
  const collectionRef = db.collection('frqs');

  console.log(`${isDryRun ? '[DRY RUN] ' : ''}Fetching all frqs docs…`);
  const snapshot = await collectionRef.get();
  console.log(`Found ${snapshot.size} total docs.`);

  const stats = {
    alreadySet: 0,
    toUpdate: 0,
    byNewSubject: { physics: 0, chemistry: 0, psychology: 0 } as Record<SubjectSlug, number>,
    unresolved: 0,
  };

  const updates: Array<{ id: string; subject: SubjectSlug }> = [];

  for (const doc of snapshot.docs) {
    const data = doc.data();
    if (typeof data.subject === 'string' && data.subject.length > 0) {
      stats.alreadySet += 1;
      continue;
    }

    const subject = inferSubject(data);
    if (!subject) {
      stats.unresolved += 1;
      console.warn(`  Could not infer subject for doc ${doc.id}. storagePath=${data.storagePath}, frqTypeShort=${data?.metadata?.frqTypeShort}`);
      continue;
    }

    stats.toUpdate += 1;
    stats.byNewSubject[subject] += 1;
    updates.push({ id: doc.id, subject });
  }

  console.log('');
  console.log('Summary:');
  console.log(`  Already had subject: ${stats.alreadySet}`);
  console.log(`  Will be updated:     ${stats.toUpdate}`);
  console.log(`    physics:    ${stats.byNewSubject.physics}`);
  console.log(`    chemistry:  ${stats.byNewSubject.chemistry}`);
  console.log(`    psychology: ${stats.byNewSubject.psychology}`);
  console.log(`  Unresolved:          ${stats.unresolved}`);
  console.log('');

  if (isDryRun) {
    console.log('Dry run complete. No docs were modified.');
    return;
  }

  if (updates.length === 0) {
    console.log('Nothing to update.');
    return;
  }

  // Firestore batches are capped at 500 writes. Chunk and commit.
  const BATCH_SIZE = 400;
  for (let i = 0; i < updates.length; i += BATCH_SIZE) {
    const chunk = updates.slice(i, i + BATCH_SIZE);
    const batch = db.batch();
    for (const { id, subject } of chunk) {
      batch.update(collectionRef.doc(id), { subject });
    }
    await batch.commit();
    console.log(`  Committed batch ${i / BATCH_SIZE + 1}: ${chunk.length} docs.`);
  }

  console.log('');
  console.log('Backfill complete.');
};

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
