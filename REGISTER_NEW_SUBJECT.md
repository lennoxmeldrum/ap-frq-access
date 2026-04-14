# Registering a new subject with the AP FRQ Archive

This file is the source of truth for "I just spun up a new generator,
how do I make it show up here?" It is referenced by name from
[`NEW_SUBJECT_PLAYBOOK.md`](https://github.com/lennoxmeldrum/apbio-infinite-frq-generator/blob/main/NEW_SUBJECT_PLAYBOOK.md)
in every generator repo, so a Claude session asked to spin up a new
subject can read it and apply the changes to this repo without
guessing.

## Prerequisites

- The new generator's `services/firestoreService.ts` must write a
  `subject` field on every `frqs/{id}` doc whose value matches the
  `slug` you'll add below.
- The generator's `services/storageService.ts` must upload the PDF
  to `frq-archive/<filename>.pdf`. Filename pattern:
  `AP <SHORT> FRQ - <TYPE> - <topics> - <timestamp>.pdf`. The
  capital-letter prefix is what `storagePrefix` below tracks.

If those two things are true, the generator is "ready" — you only
have to teach this repo about it. Don't ship code in this repo for
a generator that isn't writing to Firestore yet, otherwise the
subject card will sit on "Loading count…" forever.

## The four edits

### 1. `types.ts` — extend the `SubjectSlug` union

Add the new slug to the union literal type. The slug is the same
string the generator writes into `data.subject`:

```ts
export type SubjectSlug =
  | 'appcm'
  | 'chemistry'
  | 'psychology'
  | 'apbio'
  | '<new-slug>';   // <- add here
```

If you need a new category (e.g. you're adding the first AP English
subject), also extend `SubjectCategory` and add the new value to
`CATEGORY_ORDER` in the same file at the position you want it to
render on the picker.

### 2. `constants.ts` — add an entry to `SUBJECTS`

```ts
{
  slug: '<new-slug>',
  displayName: 'AP <Full Name>',           // "AP English Literature and Composition"
  shortName: '<Short Name>',                // "Eng Lit"
  category: '<Category>',                   // one of CATEGORY_ORDER
  colorClass: 'bg-<tailwind-color>-600',    // unique color per subject
  accentClass: 'border-<color>-600 text-<color>-700',
  storagePrefix: 'AP <SHORT> FRQ',          // matches the generator's pdfService
},
```

Pick a color that isn't already in use:
- `blue` → appcm
- `emerald` → chemistry
- `violet` → psychology
- `amber` → apbio

Other safe choices: `rose`, `cyan`, `lime`, `orange`, `indigo`,
`teal`, `fuchsia`, `slate`. Tailwind ships every color at the
600/700 weights this app uses.

### 3. (Optional) Backfill manifest if FRQs already exist

If the generator has already been writing FRQs to Firestore before
this entry was added, click **Run trigger** on the
`ap-frq-access-functions` Cloud Build trigger. The post-deploy step
calls `rebuildAllManifests` with no body, which auto-discovers every
`subject` value in Firestore (including the new one) and writes a
fresh manifest per subject to Storage. If this is a brand-new
generator that hasn't written any FRQs yet, skip this step — the
Firestore-write trigger creates the manifest automatically on the
first generation.

### 4. Verify

After merging the PR and the access site redeploys:

1. Open the picker — the new subject should appear in its category
   section with `0 FRQ` (or the actual count if you ran the
   backfill in step 3).
2. Generate one FRQ from the new generator. Within ~5 seconds the
   subject's manifest is rebuilt by the Firestore-write Cloud
   Function, and the picker count goes up on next page load.
3. Click into the subject and confirm the row appears in the
   archive table with the right Type, Units, Topics, and (if the
   generator carries `services/pricing.ts`) a non-zero Cost.

That's it. No Firestore index changes, no rules changes, no
function redeploy needed. The shared Cloud Function picks up new
subjects via the `subject` field on the doc.

## What you do NOT need to change

- Firestore composite indexes are subject-agnostic
  (`subject` + `createdAt` desc).
- Storage rules already cover `frq-archive/{allPaths=**}`.
- The Cloud Function's `rebuildManifestOnFrqWrite` trigger fires on
  every `frqs/{id}` write regardless of subject.
- Cloud Build triggers are unchanged.

## When you DO need extra work

- **New AP category** (e.g. first AP English subject): also extend
  `SubjectCategory` + `CATEGORY_ORDER` in `types.ts` (see step 1
  note).
- **Generator changes the field shape** (e.g. removes `selectedUnits`
  or renames `actualSubTopics`): update the Cloud Function
  (`functions/src/index.ts`) `mapDocToManifestItem` AND the
  client-side `manifestService.ts` `ManifestItem` interface to
  match. Then click **Run trigger** on `ap-frq-access-functions`
  to redeploy the function and reseed.
- **Generator uses a different Gemini model not in the price table**:
  add it to `PRICE_TABLE` in the generator's
  `services/pricing.ts`. The access site needs no changes — the
  cost is computed at generation time and stored on the doc.
