// Tiny formatting helpers shared across the access-site components.
// Kept in `services/` rather than `utils/` to match the existing
// directory layout — the codebase already groups every cross-cutting
// helper under `services/`.

// Render a USD amount as a 2-decimal-place dollar string. Used in:
//   - SubjectPicker      → per-subject Gemini spend label
//   - SubjectArchive     → per-FRQ Cost column
// Negatives shouldn't happen but render naturally if they ever do.
export const formatUsd = (usd: number): string => `$${usd.toFixed(2)}`;
