// Shared types for the AP FRQ Archive access site.
//
// The Firestore `frqs` collection is written by four different generators
// (Physics C: Mechanics, Chemistry, Psychology, Biology) and the doc
// shape differs slightly per subject. This site only consumes the fields
// that are common across all of them, plus metadata.frqType /
// metadata.frqTypeShort for filtering.

export type SubjectSlug = 'appcm' | 'chemistry' | 'psychology' | 'apbio';

// Subject-area groupings on the College Board's AP Central course list:
//   https://apcentral.collegeboard.org/courses
// We surface these as section headings on the subject picker so that
// once the fleet has a dozen generators live, students aren't staring
// at a flat wall of cards. Names match the College Board's wording
// exactly for discoverability.
export type SubjectCategory =
  | 'Arts'
  | 'English'
  | 'History and Social Sciences'
  | 'Math and Computer Science'
  | 'Sciences'
  | 'World Languages and Cultures';

// Canonical ordering of categories — mirrors the College Board page
// so a student scanning the picker sees the same layout they see on
// AP Central. Only populated categories render; empty ones are
// filtered out at render time.
export const CATEGORY_ORDER: SubjectCategory[] = [
  'Arts',
  'English',
  'History and Social Sciences',
  'Math and Computer Science',
  'Sciences',
  'World Languages and Cultures',
];

export interface SubjectInfo {
  slug: SubjectSlug;
  displayName: string;     // "AP Physics C: Mechanics"
  shortName: string;       // "Physics C"
  category: SubjectCategory;
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
  // Cost of the Gemini calls that produced this FRQ, stamped by
  // generators that were written after services/pricing.ts shipped.
  // Absent / zero on legacy docs. Generators provide a per-call
  // `usage` breakdown too, but the access site only surfaces the
  // total — keep the archive UI simple.
  totalCostUsd?: number;
}
