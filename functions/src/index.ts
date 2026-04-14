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
 * `rebuildManifestOnFrqWrite`, which rebuilds every subject's manifest.
 * We don't bother identifying which subject was actually affected —
 * see the note below about why we can't trust the event payload — and
 * rebuild-all is fast enough at the current scale (a handful of
 * subjects, a few thousand docs) that the extra work is negligible.
 *
 * We can't use `event.data.before` / `event.data.after` *or*
 * `event.params.frqId` even though firebase-functions' `onDocumentWritten`
 * nominally exposes them: this function is deployed via
 * `gcloud functions deploy` (see cloudbuild.functions.yaml), which
 * configures the Eventarc trigger in Pub/Sub binding mode (the request
 * URL carries `?__GCP_CloudEventsMode=CE_PUBSUB_BINDING`).
 * firebase-functions v2 doesn't decode Firestore events delivered that
 * way — both the protobuf `data` payload and the CloudEvent `subject`
 * attribute (used to populate `event.params`) come through empty. The
 * proper fix is to switch to `firebase deploy` or decode the Firestore
 * protobuf ourselves with protobufjs + a bundled data.proto; rebuild-all
 * is the simpler workaround and fine at this scale.
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
 *   "subject": "appcm",
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

// The storage bucket is normally auto-populated via the
// FIREBASE_CONFIG env var that firebase-tools injects at deploy
// time. We deploy with gcloud instead, so that env var never gets
// set — pass the bucket in explicitly from a FIREBASE_STORAGE_BUCKET
// env var (wired up in cloudbuild.functions.yaml) and fail loudly
// if it's missing so we don't silently write to the wrong bucket.
const storageBucket = process.env.FIREBASE_STORAGE_BUCKET;
if (!storageBucket) {
  throw new Error(
    'FIREBASE_STORAGE_BUCKET env var is required. Set it on the ' +
      'function deploy in cloudbuild.functions.yaml.'
  );
}

initializeApp({ storageBucket });

const FRQS_COLLECTION = 'frqs';
const MANIFEST_PATH = (subject: string) => `frq-archive/manifests/${subject}.json`;
// Bump the manifest version whenever the JSON shape changes in a
// way older clients can't handle. The access site's
// manifestService.ts stays on SUPPORTED_MANIFEST_VERSION and falls
// back to Firestore when it sees anything newer.
// v1: initial shape.
// v2: adds `totalCostUsd` to each item and a `totalCostUsd` aggregate
//     on the manifest itself. Clients on v1 code can still read v2
//     (they'll just ignore the extra fields) so we keep the version
//     at 1 and rely on `?? 0` fallbacks in consumers.
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
  // Generator-stamped cost. 0 on legacy docs; present on docs
  // written by generators carrying services/pricing.ts.
  totalCostUsd: number;
}

interface SubjectManifest {
  subject: string;
  manifestVersion: number;
  generatedAt: string;
  count: number;
  distinctFrqTypes: string[];
  // Sum of every item's `totalCostUsd`. Lets the SubjectPicker
  // show "$X.XX spent" per subject without the access site
  // having to re-sum on every render.
  totalCostUsd: number;
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
    totalCostUsd:
      typeof data.totalCostUsd === 'number' ? (data.totalCostUsd as number) : 0,
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

  // Round to a full cent at the manifest boundary. Per-item costs
  // keep six decimal places (see services/pricing.ts in the
  // generators) so sub-cent charges don't vanish, but the subject
  // total is a human-facing number and cent precision is plenty.
  const totalCostUsd =
    Math.round(items.reduce((sum, i) => sum + (i.totalCostUsd || 0), 0) * 100) / 100;

  const manifest: SubjectManifest = {
    subject,
    manifestVersion: MANIFEST_VERSION,
    generatedAt: new Date().toISOString(),
    count: items.length,
    distinctFrqTypes,
    totalCostUsd,
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

// Discover the distinct set of `subject` values currently present in
// the `frqs` collection. Used by both `rebuildAllManifests` and the
// per-write trigger (which also rebuilds every subject — see the
// top-of-file comment on why we can't pick out the affected subject
// from the event). Implemented as a full-collection scan that only
// reads the `subject` field per doc — fine up to ~50k docs, after
// which we'd want to maintain a `subjects` meta doc instead.
const discoverSubjects = async (): Promise<string[]> => {
  const db = getFirestore();
  const snapshot = await db.collection(FRQS_COLLECTION).select('subject').get();
  const seen = new Set<string>();
  for (const doc of snapshot.docs) {
    const subject = doc.get('subject');
    if (typeof subject === 'string' && subject.length > 0) {
      seen.add(subject);
    }
  }
  return Array.from(seen).sort();
};

// Rebuild the given subjects' manifests sequentially, collecting
// per-subject results (doc count on success, error message on failure).
// Factored out so the Firestore trigger and the HTTP recovery hatch
// share one codepath.
const rebuildManifestsForSubjects = async (
  subjects: string[]
): Promise<Record<string, number | string>> => {
  const results: Record<string, number | string> = {};
  for (const subject of subjects) {
    try {
      results[subject] = await rebuildManifestForSubject(subject);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Failed to rebuild manifest', { subject, err });
      results[subject] = `ERROR: ${message}`;
    }
  }
  return results;
};

// Firestore trigger: any write to `frqs/{id}` rebuilds every subject's
// manifest. See the top-of-file comment on why we can't trust the
// event payload to tell us which subject was affected.
export const rebuildManifestOnFrqWrite = onDocumentWritten(
  {
    document: `${FRQS_COLLECTION}/{frqId}`,
    region: 'us-west1',
    timeoutSeconds: 120,
    memory: '512MiB',
  },
  async (event) => {
    logger.info('Frq write observed; rebuilding all manifests', {
      eventId: event.id,
      eventType: event.type,
    });
    const subjects = await discoverSubjects();
    const results = await rebuildManifestsForSubjects(subjects);
    logger.info('Manifest rebuild complete', { results });
  }
);

// Manual recovery hatch. POST /rebuildAllManifests with no body to
// rebuild every subject currently in Firestore, or with a JSON body
// like {"subjects": ["appcm", "chemistry"]} to limit to a subset.
//
// Used to bootstrap the manifests after first deploy and to repair
// them after a Firestore restore. The post-deploy step in
// cloudbuild.functions.yaml hits this with an empty body so the seed
// step needs no maintenance when subjects are added or removed.
//
// Restricted to project-internal callers via Cloud Run IAM (deployed
// with `--no-allow-unauthenticated`); call from a Cloud Build step
// authenticated as the project SA, or via `gcloud functions call`.
export const rebuildAllManifests = onRequest(
  {
    region: 'us-west1',
    timeoutSeconds: 540,
    memory: '512MiB',
    invoker: 'private',
  },
  async (req, res) => {
    const body = (req.body ?? {}) as { subjects?: unknown };
    const requested = Array.isArray(body.subjects)
      ? (body.subjects.filter((s) => typeof s === 'string') as string[])
      : [];

    const subjects = requested.length > 0 ? requested : await discoverSubjects();

    if (subjects.length === 0) {
      res.status(404).json({
        error:
          'No subjects found in Firestore. Pass an explicit subjects list, or generate at least one FRQ first.',
      });
      return;
    }

    const results = await rebuildManifestsForSubjects(subjects);
    res.json({ rebuilt: results, requested: subjects });
  }
);
