import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { DocumentData, QueryDocumentSnapshot } from 'firebase/firestore';

import { ARCHIVE_PAGE_SIZE, SUBJECTS_BY_SLUG } from '../constants';
import {
  getDistinctFRQTypes,
  listArchivedFRQs,
} from '../services/firestoreService';
import {
  getSubjectManifest,
  manifestItemToArchivedFRQ,
} from '../services/manifestService';
import { ArchivedFRQDoc, SubjectSlug } from '../types';
import PDFPreviewPanel from './PDFPreviewPanel';

type Cursor = QueryDocumentSnapshot<DocumentData> | null;

const formatDate = (date: Date | null): string => {
  if (!date) return '—';
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
};

// The "effective" topic list for display: prefer metadata.actualSubTopics
// (what the model said it used), fall back to metadata.selectedSubTopics
// (what the user asked for). Legacy docs often only have the latter, and
// the backfill script populates actualSubTopics for them from the
// storagePath filename.
const effectiveTopics = (item: ArchivedFRQDoc): string[] => {
  const actual = item.metadata.actualSubTopics;
  if (Array.isArray(actual) && actual.length > 0) return actual;
  const selected = item.metadata.selectedSubTopics;
  if (Array.isArray(selected) && selected.length > 0) return selected;
  return [];
};

// Derive the unique unit numbers from a topic list like ["3.2", "3.5", "4.1"]
// -> ["3", "4"]. Ordered numerically.
const deriveUnits = (topics: string[]): string[] => {
  const units = new Set<string>();
  for (const topic of topics) {
    const unit = topic.split('.')[0];
    if (unit) units.add(unit);
  }
  return Array.from(units).sort((a, b) => Number(a) - Number(b));
};

const formatUnits = (topics: string[]): string => {
  const units = deriveUnits(topics);
  if (units.length === 0) return '—';
  return units.map((u) => `Unit ${u}`).join(', ');
};

const formatTopics = (topics: string[]): string => {
  if (!topics || topics.length === 0) return '—';
  return topics.join(', ');
};

type SortColumn = 'generated' | 'units' | 'topics';
type SortDirection = 'asc' | 'desc';

// Compare helper that uses natural numeric ordering where it matters
// (unit numbers, topic numbers) instead of lexicographic string order.
const compareNatural = (a: string, b: string): number =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

const compareItems = (
  a: ArchivedFRQDoc,
  b: ArchivedFRQDoc,
  column: SortColumn,
  direction: SortDirection
): number => {
  let cmp = 0;
  if (column === 'generated') {
    const at = a.createdAt?.getTime() ?? 0;
    const bt = b.createdAt?.getTime() ?? 0;
    cmp = at - bt;
  } else if (column === 'units') {
    const au = deriveUnits(effectiveTopics(a)).join(',');
    const bu = deriveUnits(effectiveTopics(b)).join(',');
    cmp = compareNatural(au, bu);
  } else if (column === 'topics') {
    const at = effectiveTopics(a).join(',');
    const bt = effectiveTopics(b).join(',');
    cmp = compareNatural(at, bt);
  }
  return direction === 'asc' ? cmp : -cmp;
};

interface SortHeaderProps {
  label: string;
  column: SortColumn;
  activeColumn: SortColumn;
  direction: SortDirection;
  onClick: (column: SortColumn) => void;
}

const SortHeader: React.FC<SortHeaderProps> = ({
  label,
  column,
  activeColumn,
  direction,
  onClick,
}) => {
  const isActive = activeColumn === column;
  const ariaSort = isActive
    ? direction === 'asc'
      ? 'ascending'
      : 'descending'
    : 'none';

  return (
    <button
      type="button"
      onClick={() => onClick(column)}
      aria-sort={ariaSort}
      className="inline-flex items-center gap-1 uppercase tracking-wider font-semibold text-xs text-gray-500 hover:text-gray-900 focus:outline-none focus:text-gray-900"
    >
      <span>{label}</span>
      <span className={`text-[9px] leading-none ${isActive ? 'opacity-100 text-gray-900' : 'opacity-30'}`}>
        {isActive ? (direction === 'asc' ? '▲' : '▼') : '▼'}
      </span>
    </button>
  );
};

// Two data sources, picked lazily at load time:
//   - 'manifest':  one HTTP GET pulls the whole subject's listing
//                  metadata, then everything (filter, sort, paginate)
//                  is in-memory. Cross-page sort is exact, paging is
//                  instant.
//   - 'firestore': legacy cursor-based path. Used when the manifest is
//                  missing/stale (e.g. function not deployed yet, or
//                  the subject has had no writes since deploy). Each
//                  page hit is a Firestore round-trip; sort is
//                  per-page only.
type Source = 'manifest' | 'firestore';

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;

const SubjectArchive: React.FC = () => {
  const params = useParams<{ subject: string }>();
  const subjectSlug = params.subject as SubjectSlug | undefined;
  const subject = subjectSlug ? SUBJECTS_BY_SLUG[subjectSlug] : undefined;

  // The full filtered+sorted list of docs for this subject when running
  // off the manifest. Empty when on the Firestore path.
  const [allItems, setAllItems] = useState<ArchivedFRQDoc[]>([]);
  // The single page of docs currently on screen. Sliced from `allItems`
  // on the manifest path, fetched per-page on the Firestore path.
  const [items, setItems] = useState<ArchivedFRQDoc[]>([]);
  const [source, setSource] = useState<Source>('manifest');
  // Cursor stack for the Firestore fallback: index N holds the cursor
  // that _started_ page N. cursorStack[0] is always null (first page).
  const [cursorStack, setCursorStack] = useState<Cursor[]>([null]);
  const [currentPage, setCurrentPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ArchivedFRQDoc | null>(null);

  const [frqTypes, setFrqTypes] = useState<string[]>([]);
  const [activeFrqType, setActiveFrqType] = useState<string | null>(null);

  // User-selectable page size. The default matches the legacy
  // ARCHIVE_PAGE_SIZE so bookmarked links keep feeling the same.
  const [pageSize, setPageSize] = useState<number>(ARCHIVE_PAGE_SIZE);

  // Client-side sort state. On the manifest path this is applied across
  // the full filtered list. On the Firestore path it only re-sorts the
  // currently loaded page in place (cross-page sort would require
  // pulling everything anyway, defeating the cursor pagination).
  const [sortColumn, setSortColumn] = useState<SortColumn>('generated');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  const handleSortClick = (column: SortColumn) => {
    if (sortColumn === column) {
      setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortColumn(column);
      setSortDirection('desc');
    }
  };

  // The trailing cursor of whatever page is currently on screen. Held in a
  // ref instead of state because it's a Firestore snapshot object and we
  // don't want to trigger renders when it changes. Only used on the
  // Firestore fallback path.
  const trailingCursorRef = useRef<Cursor>(null);

  // Mirror of `pageSize` as a ref so `loadPageFromFirestore` can read
  // the latest value without having pageSize in its deps array — that
  // would make the callback reference change on every size change,
  // which would re-trigger the main load effect and clear the selected
  // row. With the ref, size changes only rerun the effects that
  // actually need to (see handlePageSizeChange).
  const pageSizeRef = useRef(pageSize);
  pageSizeRef.current = pageSize;

  // Load via Firestore: cursor-based pagination, server-side filter.
  const loadPageFromFirestore = useCallback(
    async (cursor: Cursor) => {
      if (!subjectSlug) return;
      setLoading(true);
      setError(null);
      try {
        const result = await listArchivedFRQs({
          subject: subjectSlug,
          frqTypeShort: activeFrqType ?? undefined,
          cursor,
          pageSize: pageSizeRef.current,
        });
        setItems(result.items);
        setHasMore(result.hasMore);
        trailingCursorRef.current = result.lastDoc;
      } catch (err) {
        console.error(err);
        setError('Could not load archive. Please try again.');
        setItems([]);
        setHasMore(false);
        trailingCursorRef.current = null;
      } finally {
        setLoading(false);
      }
    },
    [subjectSlug, activeFrqType]
  );

  // Reset pagination + reload whenever subject or filter changes. Tries
  // the manifest first; on miss, falls back to the Firestore path.
  useEffect(() => {
    if (!subjectSlug) return;

    let cancelled = false;
    setLoading(true);
    setError(null);
    setSelected(null);
    setCurrentPage(0);
    setCursorStack([null]);

    (async () => {
      const manifest = await getSubjectManifest(subjectSlug);
      if (cancelled) return;

      if (manifest) {
        setSource('manifest');
        setFrqTypes(manifest.distinctFrqTypes);
        const filtered = activeFrqType
          ? manifest.items.filter(
              (item) => item.metadata.frqTypeShort === activeFrqType
            )
          : manifest.items;
        const archived = filtered.map((item) =>
          manifestItemToArchivedFRQ(subjectSlug, item)
        );
        setAllItems(archived);
        setLoading(false);
        return;
      }

      // No manifest available — fall back to the cursor path. This also
      // populates the filter chips via a separate query (manifest path
      // gets them from the manifest in a single round-trip).
      setSource('firestore');
      setAllItems([]);
      const types = await getDistinctFRQTypes(subjectSlug);
      if (cancelled) return;
      setFrqTypes(types);
      await loadPageFromFirestore(null);
    })();

    return () => {
      cancelled = true;
    };
  }, [subjectSlug, activeFrqType, loadPageFromFirestore]);

  const subjectHeader = useMemo(() => {
    if (!subject) return null;
    return (
      <div className="flex items-center gap-3 flex-wrap">
        <span className={`inline-block px-3 py-1 rounded-full text-xs font-semibold text-white ${subject.colorClass}`}>
          {subject.shortName}
        </span>
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">{subject.displayName}</h1>
      </div>
    );
  }, [subject]);

  // The full sorted list — only meaningful on the manifest path, where
  // we have every doc client-side. On the Firestore path this is empty
  // and we sort the per-page `items` array instead (see `pagedItems`).
  const sortedAllItems = useMemo(() => {
    const copy = [...allItems];
    copy.sort((a, b) => compareItems(a, b, sortColumn, sortDirection));
    return copy;
  }, [allItems, sortColumn, sortDirection]);

  // What the table actually renders. On the manifest path this is the
  // current page slice of the fully sorted list; on the Firestore path
  // it's a sort of the page that was already returned.
  const pagedItems = useMemo(() => {
    if (source === 'manifest') {
      const start = currentPage * pageSize;
      return sortedAllItems.slice(start, start + pageSize);
    }
    const copy = [...items];
    copy.sort((a, b) => compareItems(a, b, sortColumn, sortDirection));
    return copy;
  }, [source, sortedAllItems, currentPage, pageSize, items, sortColumn, sortDirection]);

  // Manifest path: derive `hasMore` and total page count from the
  // sorted full list. Firestore path: `hasMore` already came back from
  // the page query, total pages are unknown without a separate count
  // query. "Jump to last" is therefore only meaningful on the manifest
  // path; on Firestore the last-page button stays disabled.
  const totalPages = source === 'manifest'
    ? Math.max(1, Math.ceil(sortedAllItems.length / pageSize))
    : null;
  const effectiveHasMore = source === 'manifest'
    ? (currentPage + 1) * pageSize < sortedAllItems.length
    : hasMore;

  const handleFirst = async () => {
    if (currentPage === 0 || loading) return;
    if (source === 'manifest') {
      setCurrentPage(0);
      return;
    }
    setCursorStack([null]);
    setCurrentPage(0);
    await loadPageFromFirestore(null);
  };

  const handlePrev = async () => {
    if (currentPage === 0 || loading) return;
    if (source === 'manifest') {
      setCurrentPage((p) => Math.max(0, p - 1));
      return;
    }
    const newStack = cursorStack.slice(0, -1);
    const cursor = newStack[newStack.length - 1] ?? null;
    setCursorStack(newStack);
    setCurrentPage((p) => Math.max(0, p - 1));
    await loadPageFromFirestore(cursor);
  };

  const handleNext = async () => {
    if (loading) return;
    if (source === 'manifest') {
      if (!effectiveHasMore) return;
      setCurrentPage((p) => p + 1);
      return;
    }
    if (!hasMore) return;
    const nextCursor = trailingCursorRef.current;
    if (!nextCursor) return;
    setCursorStack((prev) => [...prev, nextCursor]);
    setCurrentPage((p) => p + 1);
    await loadPageFromFirestore(nextCursor);
  };

  // Only supported on the manifest path. Firestore's cursor-based
  // pagination has no O(1) way to jump to the last page without
  // walking the intermediate pages.
  const handleLast = () => {
    if (source !== 'manifest' || loading || totalPages === null) return;
    const lastIndex = totalPages - 1;
    if (currentPage >= lastIndex) return;
    setCurrentPage(lastIndex);
  };

  const handlePageSizeChange = async (nextSize: number) => {
    if (nextSize === pageSize) return;
    setPageSize(nextSize);
    // Sync the ref before the async call below so the in-flight
    // Firestore query picks up the new page size without waiting on
    // React's next render cycle.
    pageSizeRef.current = nextSize;
    // Reset to the first page — holding position across size changes
    // usually surprises more than it helps, and the current slice
    // index wouldn't translate cleanly under a different page size.
    setCurrentPage(0);
    if (source === 'firestore') {
      setCursorStack([null]);
      await loadPageFromFirestore(null);
    }
    // Manifest path needs no reload — `pagedItems` is a slice of an
    // in-memory array and the new `pageSize` flows through the memo
    // on the next render.
  };

  // If the user changes the sort while on a non-first page of the
  // manifest path, the slice they were looking at no longer makes
  // sense — snap back to page 1.
  useEffect(() => {
    if (source === 'manifest') setCurrentPage(0);
  }, [source, sortColumn, sortDirection]);

  if (!subject) {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-20 text-center">
        <h1 className="text-2xl font-bold text-gray-900">Unknown subject</h1>
        <p className="mt-2 text-gray-600">
          There is no archive for the subject in the URL. Head back to the home page to see the
          available subjects.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <div className="mb-8">{subjectHeader}</div>

      <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-6">
        {/* Left rail: filter chips */}
        <aside>
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
            FRQ Type
          </h2>
          <div className="flex flex-wrap gap-2 lg:flex-col lg:items-stretch">
            <button
              type="button"
              onClick={() => setActiveFrqType(null)}
              className={`px-3 py-2 rounded-lg text-sm font-medium text-left transition-colors ${
                activeFrqType === null
                  ? `${subject.colorClass} text-white`
                  : 'bg-white border border-gray-200 text-gray-700 hover:bg-gray-100'
              }`}
            >
              All
            </button>
            {frqTypes.map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => setActiveFrqType(type)}
                className={`px-3 py-2 rounded-lg text-sm font-medium text-left transition-colors ${
                  activeFrqType === type
                    ? `${subject.colorClass} text-white`
                    : 'bg-white border border-gray-200 text-gray-700 hover:bg-gray-100'
                }`}
              >
                {type}
              </button>
            ))}
          </div>
        </aside>

        {/* Main list */}
        <section>
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg px-4 py-3 mb-4 text-sm">
              {error}
            </div>
          )}

          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  <tr>
                    <th className="px-4 py-3">
                      <SortHeader
                        label="Generated"
                        column="generated"
                        activeColumn={sortColumn}
                        direction={sortDirection}
                        onClick={handleSortClick}
                      />
                    </th>
                    <th className="px-4 py-3">Type</th>
                    <th className="px-4 py-3 hidden md:table-cell">
                      <SortHeader
                        label="Units"
                        column="units"
                        activeColumn={sortColumn}
                        direction={sortDirection}
                        onClick={handleSortClick}
                      />
                    </th>
                    <th className="px-4 py-3 hidden lg:table-cell">
                      <SortHeader
                        label="Topics"
                        column="topics"
                        activeColumn={sortColumn}
                        direction={sortDirection}
                        onClick={handleSortClick}
                      />
                    </th>
                    <th className="px-4 py-3 text-right">Points</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {loading && pagedItems.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-4 py-12 text-center text-gray-500">
                        Loading archive…
                      </td>
                    </tr>
                  )}
                  {!loading && pagedItems.length === 0 && !error && (
                    <tr>
                      <td colSpan={5} className="px-4 py-12 text-center text-gray-500">
                        No FRQs match this filter.
                      </td>
                    </tr>
                  )}
                  {pagedItems.map((item) => {
                    const isSelected = selected?.id === item.id;
                    const topics = effectiveTopics(item);
                    return (
                      <tr
                        key={item.id}
                        className={`cursor-pointer transition-colors ${
                          isSelected ? 'bg-indigo-50' : 'hover:bg-gray-50'
                        }`}
                        onClick={() => setSelected(item)}
                      >
                        <td className="px-4 py-3 text-gray-900 whitespace-nowrap">
                          {formatDate(item.createdAt)}
                        </td>
                        <td className="px-4 py-3">
                          <span className="inline-block px-2 py-0.5 rounded bg-gray-100 text-gray-800 text-xs font-semibold">
                            {item.metadata.frqTypeShort || '—'}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-gray-600 hidden md:table-cell">
                          {formatUnits(topics)}
                          {item.metadata.wasRandom && (
                            <span className="ml-2 text-xs text-gray-400">(random)</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-gray-600 hidden lg:table-cell max-w-xs truncate">
                          {formatTopics(topics)}
                        </td>
                        <td className="px-4 py-3 text-right text-gray-900 font-medium">
                          {item.maxPoints ?? '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 bg-gray-50 border-t border-gray-200 text-sm">
              <div className="flex items-center gap-2 text-gray-600">
                <label htmlFor="page-size" className="text-gray-500">
                  Rows per page
                </label>
                <select
                  id="page-size"
                  value={pageSize}
                  onChange={(e) => handlePageSizeChange(Number(e.target.value))}
                  disabled={loading}
                  className="rounded-md border border-gray-300 bg-white px-2 py-1 text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {PAGE_SIZE_OPTIONS.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-center gap-3">
                <div className="text-gray-500">
                  Page {currentPage + 1}
                  {totalPages !== null && ` of ${totalPages}`}
                </div>
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={handleFirst}
                    disabled={currentPage === 0 || loading}
                    aria-label="First page"
                    title="First page"
                    className="px-2.5 py-1.5 rounded-md border border-gray-300 bg-white text-gray-700 hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    «
                  </button>
                  <button
                    type="button"
                    onClick={handlePrev}
                    disabled={currentPage === 0 || loading}
                    aria-label="Previous page"
                    title="Previous page"
                    className="px-2.5 py-1.5 rounded-md border border-gray-300 bg-white text-gray-700 hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    ‹
                  </button>
                  <button
                    type="button"
                    onClick={handleNext}
                    disabled={!effectiveHasMore || loading}
                    aria-label="Next page"
                    title="Next page"
                    className="px-2.5 py-1.5 rounded-md border border-gray-300 bg-white text-gray-700 hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    ›
                  </button>
                  <button
                    type="button"
                    onClick={handleLast}
                    disabled={
                      loading ||
                      source !== 'manifest' ||
                      totalPages === null ||
                      currentPage >= totalPages - 1
                    }
                    aria-label={
                      source === 'manifest'
                        ? 'Last page'
                        : 'Last page (unavailable on this view)'
                    }
                    title={
                      source === 'manifest'
                        ? 'Last page'
                        : 'Last page (unavailable while reading from Firestore directly)'
                    }
                    className="px-2.5 py-1.5 rounded-md border border-gray-300 bg-white text-gray-700 hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    »
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>

      {selected && (
        <PDFPreviewPanel frq={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
};

export default SubjectArchive;
