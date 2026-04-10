import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { DocumentData, QueryDocumentSnapshot } from 'firebase/firestore';

import { ARCHIVE_PAGE_SIZE, SUBJECTS_BY_SLUG } from '../constants';
import {
  getDistinctFRQTypes,
  listArchivedFRQs,
} from '../services/firestoreService';
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

const formatUnits = (units: (string | number)[]): string => {
  if (!units || units.length === 0) return 'Random';
  return units.map((u) => `Unit ${u}`).join(', ');
};

const formatTopics = (topics: string[]): string => {
  if (!topics || topics.length === 0) return '—';
  return topics.join(', ');
};

const SubjectArchive: React.FC = () => {
  const params = useParams<{ subject: string }>();
  const subjectSlug = params.subject as SubjectSlug | undefined;
  const subject = subjectSlug ? SUBJECTS_BY_SLUG[subjectSlug] : undefined;

  const [items, setItems] = useState<ArchivedFRQDoc[]>([]);
  // Cursor stack: index N holds the cursor that _started_ page N. cursorStack[0]
  // is always null (first page). cursorStack[1] is the lastDoc of page 0, etc.
  const [cursorStack, setCursorStack] = useState<Cursor[]>([null]);
  const [currentPage, setCurrentPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ArchivedFRQDoc | null>(null);

  const [frqTypes, setFrqTypes] = useState<string[]>([]);
  const [activeFrqType, setActiveFrqType] = useState<string | null>(null);

  // The trailing cursor of whatever page is currently on screen. Held in a
  // ref instead of state because it's a Firestore snapshot object and we
  // don't want to trigger renders when it changes.
  const trailingCursorRef = useRef<Cursor>(null);

  const loadPage = useCallback(
    async (cursor: Cursor) => {
      if (!subjectSlug) return;
      setLoading(true);
      setError(null);
      try {
        const result = await listArchivedFRQs({
          subject: subjectSlug,
          frqTypeShort: activeFrqType ?? undefined,
          cursor,
          pageSize: ARCHIVE_PAGE_SIZE,
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

  // Reset pagination + reload whenever subject or filter changes.
  useEffect(() => {
    setCursorStack([null]);
    setCurrentPage(0);
    setSelected(null);
    void loadPage(null);
  }, [loadPage]);

  // Populate filter chips with the distinct FRQ type short codes present
  // for this subject (sampled from the latest docs).
  useEffect(() => {
    if (!subjectSlug) return;
    let cancelled = false;
    (async () => {
      const types = await getDistinctFRQTypes(subjectSlug);
      if (!cancelled) setFrqTypes(types);
    })();
    return () => {
      cancelled = true;
    };
  }, [subjectSlug]);

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

  const handleNext = async () => {
    if (!hasMore || loading) return;
    const nextCursor = trailingCursorRef.current;
    if (!nextCursor) return;
    setCursorStack((prev) => [...prev, nextCursor]);
    setCurrentPage((p) => p + 1);
    await loadPage(nextCursor);
  };

  const handlePrev = async () => {
    if (currentPage === 0 || loading) return;
    const newStack = cursorStack.slice(0, -1);
    const cursor = newStack[newStack.length - 1] ?? null;
    setCursorStack(newStack);
    setCurrentPage((p) => Math.max(0, p - 1));
    await loadPage(cursor);
  };

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
                    <th className="px-4 py-3">Generated</th>
                    <th className="px-4 py-3">Type</th>
                    <th className="px-4 py-3 hidden md:table-cell">Units</th>
                    <th className="px-4 py-3 hidden lg:table-cell">Topics</th>
                    <th className="px-4 py-3 text-right">Points</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {loading && items.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-4 py-12 text-center text-gray-500">
                        Loading archive…
                      </td>
                    </tr>
                  )}
                  {!loading && items.length === 0 && !error && (
                    <tr>
                      <td colSpan={5} className="px-4 py-12 text-center text-gray-500">
                        No FRQs match this filter.
                      </td>
                    </tr>
                  )}
                  {items.map((item) => {
                    const isSelected = selected?.id === item.id;
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
                          {formatUnits(item.metadata.selectedUnits)}
                          {item.metadata.wasRandom && (
                            <span className="ml-2 text-xs text-gray-400">(random)</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-gray-600 hidden lg:table-cell max-w-xs truncate">
                          {formatTopics(item.metadata.actualSubTopics)}
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
            <div className="flex items-center justify-between px-4 py-3 bg-gray-50 border-t border-gray-200 text-sm">
              <div className="text-gray-500">Page {currentPage + 1}</div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handlePrev}
                  disabled={currentPage === 0 || loading}
                  className="px-3 py-1.5 rounded-md border border-gray-300 bg-white text-gray-700 hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Previous
                </button>
                <button
                  type="button"
                  onClick={handleNext}
                  disabled={!hasMore || loading}
                  className="px-3 py-1.5 rounded-md border border-gray-300 bg-white text-gray-700 hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Next
                </button>
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
