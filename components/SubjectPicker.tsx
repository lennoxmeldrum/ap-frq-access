import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { SUBJECTS } from '../constants';
import { getSubjectFRQCount } from '../services/firestoreService';
import { formatUsd } from '../services/format';
import { getSubjectManifest } from '../services/manifestService';
import { CATEGORY_ORDER, SubjectCategory, SubjectInfo, SubjectSlug } from '../types';

interface SubjectStats {
  count: number | null;     // null while loading, then the number of FRQs
  totalCostUsd: number;     // 0 until the manifest (or a direct count) lands
}

type StatsState = Record<SubjectSlug, SubjectStats>;

const initialStats: StatsState = SUBJECTS.reduce((acc, subject) => {
  acc[subject.slug] = { count: null, totalCostUsd: 0 };
  return acc;
}, {} as StatsState);

const SubjectCard: React.FC<{ subject: SubjectInfo; stats: SubjectStats }> = ({
  subject,
  stats,
}) => {
  const { count, totalCostUsd } = stats;
  const isLoading = count === null;
  const isDisabled = !isLoading && count === 0;

  const content = (
    <div
      className={`relative h-full rounded-2xl border-2 bg-white p-6 shadow-sm transition-all duration-200 ${
        isDisabled
          ? 'opacity-60 cursor-not-allowed border-gray-200'
          : `hover:shadow-md hover:-translate-y-0.5 border-gray-200 hover:${subject.accentClass.split(' ')[0]}`
      }`}
    >
      <div className={`inline-block px-3 py-1 rounded-full text-xs font-semibold text-white ${subject.colorClass}`}>
        {subject.shortName}
      </div>
      <h2 className="mt-4 text-xl font-semibold text-gray-900">{subject.displayName}</h2>
      <p className="mt-2 text-sm text-gray-500">
        {isLoading
          ? 'Loading count…'
          : isDisabled
          ? 'No archived FRQs yet'
          : `${count.toLocaleString()} FRQ${count === 1 ? '' : 's'} available`}
      </p>
      {!isLoading && !isDisabled && totalCostUsd > 0 && (
        <p className="mt-1 text-xs text-gray-400">
          {formatUsd(totalCostUsd)} in Gemini API spend
        </p>
      )}
      {!isDisabled && !isLoading && (
        <div className={`mt-6 text-sm font-medium ${subject.accentClass.split(' ').slice(1).join(' ')}`}>
          Browse archive →
        </div>
      )}
      {isDisabled && (
        <div className="mt-6 text-sm font-medium text-gray-400">Coming soon</div>
      )}
    </div>
  );

  if (isDisabled || isLoading) {
    return <div aria-disabled={isDisabled}>{content}</div>;
  }

  return (
    <Link
      to={`/subject/${subject.slug}`}
      className="block focus:outline-none focus:ring-2 focus:ring-indigo-500 rounded-2xl"
    >
      {content}
    </Link>
  );
};

const SubjectPicker: React.FC = () => {
  const [stats, setStats] = useState<StatsState>(initialStats);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      // Fire all subject lookups in parallel. Each one tries the
      // pre-built manifest from Storage first (one HTTP GET, no
      // Firestore round-trip). The manifest includes both the count
      // and the running cost total — so a manifest hit populates
      // both in one request. If the manifest is missing we fall back
      // to Firestore's aggregate count (and leave the cost total at
      // 0 — computing it from Firestore would mean walking every
      // doc, which defeats the point of the manifest cache).
      const results = await Promise.all(
        SUBJECTS.map(async (subject) => {
          const manifest = await getSubjectManifest(subject.slug);
          if (manifest) {
            return [
              subject.slug,
              { count: manifest.count, totalCostUsd: manifest.totalCostUsd ?? 0 },
            ] as const;
          }
          const count = await getSubjectFRQCount(subject.slug);
          return [subject.slug, { count, totalCostUsd: 0 }] as const;
        })
      );

      if (cancelled) return;
      setStats((prev) => {
        const next = { ...prev };
        for (const [slug, subjectStats] of results) {
          next[slug] = subjectStats;
        }
        return next;
      });
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Group subjects by the College Board category they belong to.
  // Categories with zero registered subjects are omitted from the
  // rendered output entirely — no empty headers — so the UI grows
  // organically as new subjects come online.
  const byCategory = useMemo(() => {
    const groups = new Map<SubjectCategory, SubjectInfo[]>();
    for (const subject of SUBJECTS) {
      const list = groups.get(subject.category) ?? [];
      list.push(subject);
      groups.set(subject.category, list);
    }
    return CATEGORY_ORDER
      .filter((category) => (groups.get(category)?.length ?? 0) > 0)
      .map((category) => ({
        category,
        subjects: groups.get(category)!,
      }));
  }, []);

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-12 sm:py-20">
      <div className="text-center mb-12">
        <h1 className="text-3xl sm:text-4xl font-bold text-gray-900">AP FRQ Archive</h1>
        <p className="mt-3 text-base sm:text-lg text-gray-600 max-w-2xl mx-auto">
          Browse and download every AP Free Response Question generated by the AP Infinite
          FRQ Generators. Pick a subject to get started.
        </p>
      </div>

      <div className="space-y-12">
        {byCategory.map(({ category, subjects }) => (
          <section key={category}>
            <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-500 border-b border-gray-200 pb-2 mb-6">
              {category}
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
              {subjects.map((subject) => (
                <SubjectCard
                  key={subject.slug}
                  subject={subject}
                  stats={stats[subject.slug]}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
};

export default SubjectPicker;
