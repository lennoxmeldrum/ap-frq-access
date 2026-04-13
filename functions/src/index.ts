/**
 * Cloud Functions for the AP FRQ Archive site.
 *
 * The functions in this directory exist for one purpose: keep the
 * per-subject manifest JSON in Firebase Storage in sync with the `frqs`
 * collection in Firestore. The access site reads the manifest in a
 * single Storage download, paginates client-side, and only falls back
 * to direct Firestore queries when the manifest is missing.
 *
 * Trigger model
 * -------------
 * Any write (create / update / delete) to `frqs/{id}` fires
 * `rebuildManifestOnFrqWrite`. The function reads the doc, infers the
 * affected subject(s) (the previous and the new value of `data.subject`
 * — they differ if a backfill rewrites the subject field), and rebuilds
 * each affected subject's manifest.
 *
 * Concurrency
 * -----------
 * Multiple writes in flight will each rebuild the manifest. The last
 * write wins. We don't bother with locking or debouncing for v1 — the
 * generators produce FRQs at human pace (one every ~30s), each rebuild
 * is a few seconds, and the cost of an occasional double rebuild is
 * negligible.
 *
 * Manifest format (v1)
 * --------------------
 * `frq-archive/manifests/<subject>.json`:
 * {
 *   "subject": "physics",
 *   "manifestVersion": 1,
 *   "generatedAt": "2026-04-13T08:30:00.000Z",
 *   "count": 247,
 *   "distinctFrqTypes": ["LAB", "MR", "QQT", "TBR"],
 *   "items": [ ManifestItem, ... ]   // sorted createdAt desc
 * }
 *
 * `manifestVersion` lets us evolve the schema without breaking older
 * clients — the access site reads the version and falls back to a
 * direct Firestore query if it sees something it doesn't understand.
 */

import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onRequest } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';

initializeApp();

const FRQS_COLLECTION = 'frqs';
const MANIFEST_PATH = (subject: string) => `frq-archive/manifests/${subject}.json`;
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

interface SubjectManifest {
  subject: string;
  manifestVersion: number;
  generatedAt: string;
  count: number;
  distinctFrqTypes: string[];
  items: ManifestItem[];
}

const toISODate = (value: unknown): string | null => {
  if (!value) return null;
  if (value instanceof Timestamp) return value.toDate().toISOString();
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

// Read every doc in `frqs` for a single subject, build the manifest,
// and write it to Storage. Idempotent — calling it twice in a row
// produces byte-identical output (apart from `generatedAt`).
export const rebuildManifestForSubject = async (subject: string): Promise<number> => {
  const db = getFirestore();
  const snapshot = await db
    .collection(FRQS_COLLECTION)
    .where('subject', '==', subject)
    .orderBy('createdAt', 'desc')
    .get();

  const items: ManifestItem[] = snapshot.docs.map((doc) =>
    mapDocToManifestItem(doc.id, doc.data())
  );

  const distinctFrqTypes = Array.from(
    new Set(
      items
        .map((item) => item.metadata.frqTypeShort)
        .filter((short): short is string => typeof short === 'string' && short.length > 0)
    )
  ).sort();

  const manifest: SubjectManifest = {
    subject,
    manifestVersion: MANIFEST_VERSION,
    generatedAt: new Date().toISOString(),
    count: items.length,
    distinctFrqTypes,
    items,
  };

  const bucket = getStorage().bucket();
  const file = bucket.file(MANIFEST_PATH(subject));
  await file.save(JSON.stringify(manifest), {
    contentType: 'application/json',
    // Don't cache aggressively — we want a refreshed manifest within
    // seconds of a new FRQ landing. The Storage CDN otherwise caches
    // public objects for an hour by default.
    metadata: {
      cacheControl: 'public, max-age=30, must-revalidate',
    },
    resumable: false,
  });

  logger.info('Wrote manifest', {
    subject,
    count: items.length,
    distinctFrqTypes,
  });

  return items.length;
};

// Firestore trigger: any write to `frqs/{id}` rebuilds the manifest(s)
// for the subject(s) affected. We rebuild for both the before-value and
// after-value subjects so that backfills which change the subject field
// (e.g. backfill-subject-field.ts) end up reflected in both manifests.
export const rebuildManifestOnFrqWrite = onDocumentWritten(
  {
    document: `${FRQS_COLLECTION}/{frqId}`,
    region: 'us-central1',
    timeoutSeconds: 120,
    memory: '512MiB',
  },
  async (event) => {
    const before = event.data?.before?.data() as FirebaseFirestore.DocumentData | undefined;
    const after = event.data?.after?.data() as FirebaseFirestore.DocumentData | undefined;

    const subjects = new Set<string>();
    const beforeSubject = before?.subject as string | undefined;
    const afterSubject = after?.subject as string | undefined;
    if (beforeSubject) subjects.add(beforeSubject);
    if (afterSubject) subjects.add(afterSubject);

    if (subjects.size === 0) {
      logger.warn('Skipping manifest rebuild — no subject on doc', {
        frqId: event.params.frqId,
      });
      return;
    }

    for (const subject of subjects) {
      try {
        await rebuildManifestForSubject(subject);
      } catch (err) {
        logger.error('Failed to rebuild manifest', { subject, err });
      }
    }
  }
);

// Manual recovery hatch. POST /rebuildAllManifests with a JSON body
// like {"subjects": ["physics", "chemistry", "psychology", "apbio"]}.
// Used to bootstrap the manifests after first deploy, or to repair
// them after a Firestore restore. Restricted to project-internal
// callers via Cloud Run IAM (default `--no-allow-unauthenticated`
// when deploying functions); call with `gcloud functions call` or
// from a Cloud Build step authenticated as the project SA.
export const rebuildAllManifests = onRequest(
  {
    region: 'us-central1',
    timeoutSeconds: 540,
    memory: '512MiB',
    invoker: 'private',
  },
  async (req, res) => {
    const body = (req.body ?? {}) as { subjects?: unknown };
    const subjects = Array.isArray(body.subjects)
      ? (body.subjects.filter((s) => typeof s === 'string') as string[])
      : [];

    if (subjects.length === 0) {
      res.status(400).json({ error: 'Body must include { "subjects": [...] }' });
      return;
    }

    const results: Record<string, number | string> = {};
    for (const subject of subjects) {
      try {
        results[subject] = await rebuildManifestForSubject(subject);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results[subject] = `ERROR: ${message}`;
      }
    }

    res.json({ rebuilt: results });
  }
);
