import React, { useEffect, useState } from 'react';

import { resolveStorageDownloadURL } from '../services/storageService';
import { ArchivedFRQDoc } from '../types';

interface Props {
  frq: ArchivedFRQDoc;
  onClose: () => void;
}

const isMobileUserAgent = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  return /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent);
};

const formatDate = (date: Date | null): string => {
  if (!date) return '—';
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
};

const getFilename = (storagePath: string | null): string => {
  if (!storagePath) return 'frq.pdf';
  const parts = storagePath.split('/');
  return parts[parts.length - 1] || 'frq.pdf';
};

const PDFPreviewPanel: React.FC<Props> = ({ frq, onClose }) => {
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isMobile] = useState<boolean>(() => isMobileUserAgent());

  // Close the panel when the user hits Escape.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // Resolve the download URL whenever the selected FRQ changes.
  useEffect(() => {
    let cancelled = false;
    setDownloadUrl(null);
    setError(null);
    setLoading(true);

    if (!frq.storagePath) {
      setError('No PDF attached to this record.');
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }

    (async () => {
      const url = await resolveStorageDownloadURL(frq.storagePath!);
      if (cancelled) return;
      if (!url) {
        setError('Could not resolve PDF URL.');
      } else {
        setDownloadUrl(url);
      }
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [frq]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch sm:items-center justify-center bg-black/40 backdrop-blur-sm p-0 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label="FRQ PDF preview"
      onClick={onClose}
    >
      <div
        className="bg-white w-full sm:max-w-5xl sm:max-h-[90vh] flex flex-col rounded-none sm:rounded-2xl shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between px-5 py-4 border-b border-gray-200 gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="inline-block px-2 py-0.5 rounded bg-gray-100 text-gray-800 text-xs font-semibold">
                {frq.metadata.frqTypeShort || 'FRQ'}
              </span>
              {frq.metadata.wasRandom && (
                <span className="text-xs text-gray-500">Random selection</span>
              )}
            </div>
            <h2 className="mt-1 text-base sm:text-lg font-semibold text-gray-900 truncate">
              {frq.metadata.frqType || 'Archived FRQ'}
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Generated {formatDate(frq.createdAt)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 text-gray-500 hover:text-gray-800 hover:bg-gray-100 rounded-md"
            aria-label="Close preview"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Metadata strip */}
        <div className="px-5 py-3 bg-gray-50 border-b border-gray-200 text-xs text-gray-600 grid grid-cols-1 sm:grid-cols-3 gap-2">
          <div>
            <span className="font-semibold text-gray-500 uppercase tracking-wider text-[10px]">Units</span>
            <div className="mt-0.5">
              {frq.metadata.selectedUnits && frq.metadata.selectedUnits.length > 0
                ? frq.metadata.selectedUnits.map((u) => `Unit ${u}`).join(', ')
                : 'Random'}
            </div>
          </div>
          <div>
            <span className="font-semibold text-gray-500 uppercase tracking-wider text-[10px]">Topics</span>
            <div className="mt-0.5 break-words">
              {frq.metadata.actualSubTopics && frq.metadata.actualSubTopics.length > 0
                ? frq.metadata.actualSubTopics.join(', ')
                : '—'}
            </div>
          </div>
          <div>
            <span className="font-semibold text-gray-500 uppercase tracking-wider text-[10px]">Max points</span>
            <div className="mt-0.5">{frq.maxPoints ?? '—'}</div>
          </div>
        </div>

        {/* Body: PDF preview */}
        <div className="flex-1 bg-gray-100 min-h-[300px] sm:min-h-[500px] overflow-hidden">
          {loading && (
            <div className="h-full flex items-center justify-center text-sm text-gray-500">
              Loading PDF…
            </div>
          )}
          {!loading && error && (
            <div className="h-full flex items-center justify-center p-8 text-center">
              <div>
                <p className="text-sm text-red-700 font-medium">{error}</p>
                <p className="text-xs text-gray-500 mt-1">
                  The record may be from before the archive filename fix.
                </p>
              </div>
            </div>
          )}
          {!loading && !error && downloadUrl && !isMobile && (
            <iframe
              src={downloadUrl}
              title="FRQ PDF preview"
              className="w-full h-full min-h-[500px] border-0"
            />
          )}
          {!loading && !error && downloadUrl && isMobile && (
            <div className="h-full flex items-center justify-center p-8 text-center">
              <div>
                <p className="text-sm text-gray-700">
                  Inline PDF preview isn't reliable on mobile.
                </p>
                <p className="text-xs text-gray-500 mt-1">
                  Use the download button below to open this FRQ.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className="px-5 py-3 border-t border-gray-200 bg-white flex items-center justify-between gap-3">
          <p className="text-xs text-gray-500 truncate">{getFilename(frq.storagePath)}</p>
          <a
            href={downloadUrl ?? '#'}
            download={getFilename(frq.storagePath)}
            target="_blank"
            rel="noopener noreferrer"
            aria-disabled={!downloadUrl}
            className={`inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-semibold text-white transition-colors ${
              downloadUrl
                ? 'bg-indigo-600 hover:bg-indigo-700'
                : 'bg-gray-300 cursor-not-allowed pointer-events-none'
            }`}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Download PDF
          </a>
        </div>
      </div>
    </div>
  );
};

export default PDFPreviewPanel;
