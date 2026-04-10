/**
 * One-time backfill for legacy FRQ docs that have no
 * `metadata.actualSubTopics` field. The generators only started
 * stamping that field recently, so older docs show "—" in the Topics
 * column and "Random" in the Units column even when the PDF itself
 * clearly lists the topics the model used.
 *
 * The storagePath filename preserves those topics. This script reads
 * every doc in `frqs`, parses the filename, and writes the resulting
 * topic array back to `metadata.actualSubTopics`.
 *
 * Filename formats handled
 * ------------------------
 *   Current (topic / topics prefix, may have a timestamp suffix):
 *     frq-archive/AP PCM FRQ - MR - topic 3.1.pdf
 *     frq-archive/AP PCM FRQ - MR - topics 3.1, 3.2, 3.3.pdf
 *     frq-archive/AP PCM FRQ - MR - topics 3.1, 3.2, 3.3 - 20260410-220533-123.pdf
 *
 *   Legacy (unit prefix, no timestamp suffix):
 *     frq-archive/AP PCM FRQ - MR - unit 3.1, 3.2, 3.3.pdf
 *
 *   Random fallback (any subject, any era):
 *     frq-archive/AP PCM FRQ - MR - random.pdf
 *     frq-archive/AP PCM FRQ - MR - random - 20260410-220533-123.pdf
 *
 * Usage (no CLI required)
 * -----------------------
 * Driven by `cloudbuild.backfill.yaml`. Set the substitution
 * `_BACKFILL_SCRIPT=scripts/backfill-actual-topics.ts` when you click
 * Run on the `ap-frq-access-backfill` Cloud Build trigger. See that
 * file for the full click-path and IAM requirements.
 *
 *   Dry run first:
 *     _BACKFILL_SCRIPT=scripts/backfill-actual-topics.ts
 *     _DRY_RUN=--dry-run
 *
 *   Real run:
 *     _BACKFILL_SCRIPT=scripts/backfill-actual-topics.ts
 *     _DRY_RUN=           (empty)
 *
 * After a successful real run, verify the Topics and Units columns on
 * the deployed access site look correct, then delete this script and
 * the backfill trigger so neither can fire again by accident.
 */

import admin from 'firebase-admin';

// Parse the topic list out of a storagePath filename. Returns:
//   null          — couldn't parse at all (will be logged)
//   []            — filename explicitly says "random" (skip update)
//   [..strings..] — topic IDs like ["3.1", "3.2", "3.3"]
const parseTopicsFromStoragePath = (storagePath: string): string[] | null => {
  // Strip any folder prefix (e.g. "frq-archive/")
  let name = storagePath.replace(/^.*\//, '');
  // Strip the .pdf extension
  name = name.replace(/\.pdf$/i, '');
  // Strip the archive timestamp suffix if present:
  //   " - 20260410-220533-123"
  name = name.replace(/\s+-\s+\d{8}-\d{6}-\d{3}$/, '');

  // Explicit "random" marker — no topics to extract.
  if (/\brandom\s*$/i.test(name)) {
    return [];
  }

  // Match one of:
  //   "topic 3.1"
  //   "topics 3.1, 3.2, 3.3"
  //   "unit 3.1, 3.2, 3.3"           (legacy)
  // and capture the comma-separated topic list.
  const match = /\b(?:topics?|unit)\s+((?:\d+\.\d+)(?:\s*,\s*\d+\.\d+)*)/i.exec(name);
  if (!match) return null;

  return match[1]
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
};

const main = async () => {
  const isDryRun = process.argv.includes('--dry-run');

  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });

  const db = admin.firestore();
  const collectionRef = db.collection('frqs');

  console.log(`${isDryRun ? '[DRY RUN] ' : ''}Fetching all frqs docs…`);
  const snapshot = await collectionRef.get();
  console.log(`Found ${snapshot.size} total docs.`);

  const stats = {
    alreadyHasTopics: 0,
    updated: 0,
    noStoragePath: 0,
    randomSkipped: 0,
    parseFailed: 0,
  };

  const updates: Array<{ id: string; actualSubTopics: string[] }> = [];

  for (const doc of snapshot.docs) {
    const data = doc.data();
    const metadata = (data.metadata ?? {}) as Record<string, unknown>;
    const current = metadata.actualSubTopics;

    // Skip docs that already have a non-empty actualSubTopics array.
    // These were written by the modern generators and are already
    // correct.
    if (Array.isArray(current) && current.length > 0) {
      stats.alreadyHasTopics += 1;
      continue;
    }

    const storagePath = data.storagePath as string | null | undefined;
    if (!storagePath) {
      stats.noStoragePath += 1;
      continue;
    }

    const parsed = parseTopicsFromStoragePath(storagePath);
    if (parsed === null) {
      stats.parseFailed += 1;
      console.warn(`  Parse failed: doc ${doc.id} storagePath=${storagePath}`);
      continue;
    }

    if (parsed.length === 0) {
      // Filename was literally "random". Nothing to write — the access
      // site will derive the Units column from selectedSubTopics or
      // fall back to an em-dash.
      stats.randomSkipped += 1;
      continue;
    }

    stats.updated += 1;
    updates.push({ id: doc.id, actualSubTopics: parsed });
  }

  console.log('');
  console.log('Summary:');
  console.log(`  Already had actualSubTopics: ${stats.alreadyHasTopics}`);
  console.log(`  Will be updated:             ${stats.updated}`);
  console.log(`  No storagePath field:        ${stats.noStoragePath}`);
  console.log(`  Random (no change):          ${stats.randomSkipped}`);
  console.log(`  Parse failed:                ${stats.parseFailed}`);
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
    for (const { id, actualSubTopics } of chunk) {
      batch.update(collectionRef.doc(id), {
        'metadata.actualSubTopics': actualSubTopics,
      });
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
