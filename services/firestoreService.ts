import {
  collection,
  DocumentData,
  DocumentSnapshot,
  Firestore,
  getCountFromServer,
  getDocs,
  getFirestore,
  limit,
  orderBy,
  query,
  QueryConstraint,
  QueryDocumentSnapshot,
  startAfter,
  Timestamp,
  where,
} from 'firebase/firestore';

import { ARCHIVE_PAGE_SIZE, FRQS_COLLECTION } from '../constants';
import { ArchivedFRQDoc, SubjectSlug } from '../types';
import { getFirebaseAppWithAuth, isFirestoreConfigured } from './firebaseService';

let firestore: Firestore | null = null;

const initializeFirestore = async (): Promise<Firestore | null> => {
  if (!isFirestoreConfigured()) {
    console.log('Firebase not configured - Firestore disabled');
    return null;
  }

  if (!firestore) {
    const app = await getFirebaseAppWithAuth();
    if (!app) return null;
    firestore = getFirestore(app);
  }

  return firestore;
};

const toDate = (value: unknown): Date | null => {
  if (!value) return null;
  if (value instanceof Timestamp) return value.toDate();
  if (value instanceof Date) return value;
  return null;
};

const mapDocToArchivedFRQ = (
  snapshot: DocumentSnapshot<DocumentData> | QueryDocumentSnapshot<DocumentData>
): ArchivedFRQDoc => {
  const data = snapshot.data() ?? {};
  const metadata = (data.metadata ?? {}) as Record<string, unknown>;

  return {
    id: snapshot.id,
    subject: (data.subject as SubjectSlug | undefined) ?? undefined,
    maxPoints: typeof data.maxPoints === 'number' ? (data.maxPoints as number) : undefined,
    metadata: {
      frqType: (metadata.frqType as string) ?? '',
      frqTypeShort: (metadata.frqTypeShort as string) ?? '',
      selectedUnits: (metadata.selectedUnits as (string | number)[]) ?? [],
      selectedSubTopics: (metadata.selectedSubTopics as string[]) ?? [],
      actualSubTopics: (metadata.actualSubTopics as string[]) ?? [],
      wasRandom: Boolean(metadata.wasRandom),
    },
    storagePath: (data.storagePath as string | null | undefined) ?? null,
    createdAt: toDate(data.createdAt),
  };
};

// Count the archived FRQs for a single subject. Used by the landing page
// to render "N FRQs available" on each subject card.
export const getSubjectFRQCount = async (subject: SubjectSlug): Promise<number> => {
  const db = await initializeFirestore();
  if (!db) return 0;

  try {
    const q = query(collection(db, FRQS_COLLECTION), where('subject', '==', subject));
    const snapshot = await getCountFromServer(q);
    return snapshot.data().count;
  } catch (error) {
    console.error(`Failed to count FRQs for subject "${subject}":`, error);
    return 0;
  }
};

export interface ListArchivedFRQsOptions {
  subject: SubjectSlug;
  frqTypeShort?: string;       // Filter to a single FRQ type short code
  pageSize?: number;
  cursor?: QueryDocumentSnapshot<DocumentData> | null;
}

export interface ListArchivedFRQsResult {
  items: ArchivedFRQDoc[];
  lastDoc: QueryDocumentSnapshot<DocumentData> | null;
  hasMore: boolean;
}

// Paginated list of archived FRQs for a subject, ordered by createdAt desc.
// Relies on the (subject asc, createdAt desc) composite index declared in
// firestore.indexes.json. The optional frqTypeShort filter is applied via
// a third equality predicate; if you add it, make sure the index covers it.
export const listArchivedFRQs = async ({
  subject,
  frqTypeShort,
  pageSize = ARCHIVE_PAGE_SIZE,
  cursor = null,
}: ListArchivedFRQsOptions): Promise<ListArchivedFRQsResult> => {
  const db = await initializeFirestore();
  if (!db) return { items: [], lastDoc: null, hasMore: false };

  const constraints: QueryConstraint[] = [where('subject', '==', subject)];
  if (frqTypeShort) {
    constraints.push(where('metadata.frqTypeShort', '==', frqTypeShort));
  }
  constraints.push(orderBy('createdAt', 'desc'));
  if (cursor) {
    constraints.push(startAfter(cursor));
  }
  // Fetch one extra doc so we can tell the caller whether another page exists.
  constraints.push(limit(pageSize + 1));

  try {
    const q = query(collection(db, FRQS_COLLECTION), ...constraints);
    const snapshot = await getDocs(q);

    const docs = snapshot.docs;
    const hasMore = docs.length > pageSize;
    const pageDocs = hasMore ? docs.slice(0, pageSize) : docs;

    return {
      items: pageDocs.map(mapDocToArchivedFRQ),
      lastDoc: pageDocs.length > 0 ? pageDocs[pageDocs.length - 1] : null,
      hasMore,
    };
  } catch (error) {
    console.error('Failed to list archived FRQs:', error);
    return { items: [], lastDoc: null, hasMore: false };
  }
};

// Pull the distinct set of frqTypeShort values for a subject, used to
// populate filter chips. This is a small scan over the first N docs —
// Firestore has no native DISTINCT, so we sample the most recent page.
export const getDistinctFRQTypes = async (
  subject: SubjectSlug,
  sampleSize = 200
): Promise<string[]> => {
  const db = await initializeFirestore();
  if (!db) return [];

  try {
    const q = query(
      collection(db, FRQS_COLLECTION),
      where('subject', '==', subject),
      orderBy('createdAt', 'desc'),
      limit(sampleSize)
    );
    const snapshot = await getDocs(q);

    const types = new Set<string>();
    for (const doc of snapshot.docs) {
      const data = doc.data();
      const short = data?.metadata?.frqTypeShort;
      if (typeof short === 'string' && short.length > 0) {
        types.add(short);
      }
    }
    return Array.from(types).sort();
  } catch (error) {
    console.error('Failed to fetch distinct FRQ types:', error);
    return [];
  }
};
