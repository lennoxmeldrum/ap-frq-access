import {
  FirebaseStorage,
  getDownloadURL,
  getStorage,
  ref,
} from 'firebase/storage';

import { ArchivedFRQDoc, SubjectSlug } from '../types';
import {
  getFirebaseAppWithAuth,
  isStorageConfigured,
} from './firebaseService';

// Schema this client knows how to read. If a manifest in Storage has a
// higher version, we treat it as unreadable and fall back to direct
// Firestore queries — which is also what we do if the manifest is
// missing entirely. This lets us evolve the manifest format on the
// build side without breaking older deployed clients.
const SUPPORTED_MANIFEST_VERSION = 1;

const MANIFEST_PATH = (subject: SubjectSlug) =>
  `frq-archive/manifests/${subject}.json`;

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
  // Optional on the client side — manifests written before cost
  // tracking shipped don't have it, and neither do docs written by
  // generators that haven't picked up services/pricing.ts yet.
  // Consumers fall back to 0 via `?? 0`.
  totalCostUsd?: number;
}

export interface SubjectManifest {
  subject: SubjectSlug;
  manifestVersion: number;
  generatedAt: string;
  count: number;
  distinctFrqTypes: string[];
  // Aggregate across items. Same "optional on old manifests" story
  // as the per-item field.
  totalCostUsd?: number;
  items: ManifestItem[];
}

let storage: FirebaseStorage | null = null;

const initializeFirebaseStorage = async (): Promise<FirebaseStorage | null> => {
  if (!isStorageConfigured()) return null;
  if (!storage) {
    const app = await getFirebaseAppWithAuth();
    if (!app) return null;
    storage = getStorage(app);
  }
  return storage;
};

// Module-scoped cache. The manifest is small enough (a few KB up to a
// few MB even for a multi-thousand-doc subject) that holding the parsed
// JSON in memory for the session is fine. Re-fetched on hard reload.
const manifestCache = new Map<SubjectSlug, SubjectManifest | null>();
const inflight = new Map<SubjectSlug, Promise<SubjectManifest | null>>();

// Returns the cached manifest for the subject, fetching from Storage on
// first call. Returns null on any failure (manifest missing, Storage
// unconfigured, network error, schema version too new). Callers that
// get null should fall back to direct Firestore queries.
export const getSubjectManifest = async (
  subject: SubjectSlug
): Promise<SubjectManifest | null> => {
  if (manifestCache.has(subject)) {
    return manifestCache.get(subject) ?? null;
  }

  const existing = inflight.get(subject);
  if (existing) return existing;

  const promise = (async (): Promise<SubjectManifest | null> => {
    try {
      const storageInstance = await initializeFirebaseStorage();
      if (!storageInstance) return null;

      const url = await getDownloadURL(
        ref(storageInstance, MANIFEST_PATH(subject))
      );
      const response = await fetch(url);
      if (!response.ok) return null;

      const json = (await response.json()) as Partial<SubjectManifest>;
      if (
        typeof json !== 'object' ||
        json === null ||
        json.manifestVersion !== SUPPORTED_MANIFEST_VERSION ||
        !Array.isArray(json.items)
      ) {
        console.warn(
          `Manifest for "${subject}" has unsupported version or shape`,
          { manifestVersion: json?.manifestVersion }
        );
        return null;
      }

      return json as SubjectManifest;
    } catch (err) {
      // Storage SDK throws "object-not-found" the first time around,
      // before the function has had a chance to write the manifest.
      // That's expected — log at debug level, not error.
      console.debug(`No manifest available for "${subject}":`, err);
      return null;
    } finally {
      inflight.delete(subject);
    }
  })();

  inflight.set(subject, promise);
  const result = await promise;
  manifestCache.set(subject, result);
  return result;
};

// Force a re-fetch on the next call. Used when the user clicks an
// explicit "Refresh" affordance, or when we detect that our cached
// manifest is stale (e.g. user expected to see a doc that isn't there).
export const invalidateManifest = (subject?: SubjectSlug): void => {
  if (subject) {
    manifestCache.delete(subject);
    inflight.delete(subject);
  } else {
    manifestCache.clear();
    inflight.clear();
  }
};

const parseDate = (iso: string | null): Date | null => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
};

// Materialize a manifest item into the same ArchivedFRQDoc shape the
// rest of the app expects. The manifest stores `createdAt` as an ISO
// string for JSON-friendliness; the consuming components want a Date.
export const manifestItemToArchivedFRQ = (
  subject: SubjectSlug,
  item: ManifestItem
): ArchivedFRQDoc => ({
  id: item.id,
  subject,
  maxPoints: item.maxPoints ?? undefined,
  metadata: item.metadata,
  storagePath: item.storagePath ?? null,
  createdAt: parseDate(item.createdAt),
  totalCostUsd: item.totalCostUsd ?? 0,
});
