import { SubjectInfo, SubjectSlug } from './types';

// Canonical subject list. To add a new subject to the archive after its
// generator is live: add an entry here, confirm the generator writes the
// matching `subject` slug on every FRQ doc, and (if needed) backfill any
// docs it wrote before the field existed.
export const SUBJECTS: SubjectInfo[] = [
  {
    slug: 'physics',
    displayName: 'AP Physics C: Mechanics',
    shortName: 'Physics C: Mechanics',
    colorClass: 'bg-blue-600',
    accentClass: 'border-blue-600 text-blue-700',
    storagePrefix: 'AP PCM FRQ',
  },
  {
    slug: 'chemistry',
    displayName: 'AP Chemistry',
    shortName: 'Chemistry',
    colorClass: 'bg-emerald-600',
    accentClass: 'border-emerald-600 text-emerald-700',
    storagePrefix: 'AP CHEM FRQ',
  },
  {
    slug: 'psychology',
    displayName: 'AP Psychology',
    shortName: 'Psychology',
    colorClass: 'bg-violet-600',
    accentClass: 'border-violet-600 text-violet-700',
    storagePrefix: 'AP PSYCH FRQ',
  },
];

export const SUBJECTS_BY_SLUG: Record<SubjectSlug, SubjectInfo> = SUBJECTS.reduce(
  (acc, subject) => {
    acc[subject.slug] = subject;
    return acc;
  },
  {} as Record<SubjectSlug, SubjectInfo>
);

// Firestore collection name — shared across all generators.
export const FRQS_COLLECTION = 'frqs';

// Page size for the paginated archive list.
export const ARCHIVE_PAGE_SIZE = 25;
