// Shared types for the AP FRQ Archive access site.
//
// The Firestore `frqs` collection is written by three different generators
// (Physics C: Mechanics, Chemistry, Psychology) and the doc shape differs
// slightly per subject. This site only consumes the fields that are common
// across all three, plus metadata.frqType / metadata.frqTypeShort for
// filtering.

export type SubjectSlug = 'physics' | 'chemistry' | 'psychology';

export interface SubjectInfo {
  slug: SubjectSlug;
  displayName: string;     // "AP Physics C: Mechanics"
  shortName: string;       // "Physics C"
  colorClass: string;      // Tailwind background class for the subject card
  accentClass: string;     // Tailwind accent / border class
  // Storage path prefix used for backfill and "eyeball" identification of
  // legacy docs whose `subject` field has not been set yet.
  storagePrefix: string;
}

export interface ArchivedFRQMetadata {
  frqType: string;              // Full label e.g. "Article Analysis Question (AAQ)"
  frqTypeShort: string;         // Short code e.g. "AAQ", "MR", "Short"
  selectedUnits: (string | number)[];
  selectedSubTopics: string[];
  actualSubTopics: string[];
  wasRandom: boolean;
}

// Firestore `frqs/{docId}` document as consumed by this site.
// Only the fields needed for listing / previewing are declared.
export interface ArchivedFRQDoc {
  id: string;
  subject?: SubjectSlug;        // Absent on legacy docs until backfill runs
  maxPoints?: number;
  metadata: ArchivedFRQMetadata;
  storagePath: string | null;
  createdAt: Date | null;
}
