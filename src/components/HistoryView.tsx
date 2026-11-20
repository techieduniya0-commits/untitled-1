import { useMemo, useState } from 'react';
import {
  ArrowUpRight,
  AudioWaveform,
  Download,
  FileSearch,
  FileText,
  Film,
  Image as ImageIcon,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import type { AnalysisRecord, Classification, MediaType } from '../types/forensics';
import {
  classificationTone,
  exportForensicPdfReport,
  formatBytes,
  formatDateTime,
  mediaTypeLabel,
} from '../lib/formatters';
import { PremiumButton } from './PremiumUi';

interface HistoryViewProps {
  mode: 'analyses' | 'history' | 'reports';
  analyses: AnalysisRecord[];
  loading: boolean;
  onOpenAnalysis: (record: AnalysisRecord) => void;
  onDeleteAnalysis: (id: string) => Promise<void>;
  onStartUpload: () => void;
}

const MEDIA_FILTERS: Array<{ id: 'all' | MediaType; label: string }> = [
  { id: 'all', label: 'All media' },
  { id: 'image', label: 'Images' },
  { id: 'video', label: 'Videos' },
  { id: 'pdf', label: 'PDFs' },
  { id: 'document', label: 'Text docs' },
  { id: 'audio', label: 'Audio' },
];

const CLASSIFICATION_OPTIONS: Array<'all' | Classification> = [
  'all',
  'Likely AI-generated',
  'Potentially AI-assisted',
  'Potentially manipulated',
  'Inconclusive',
  'Likely human-created',
];

function TypeIcon({ type }: { type: MediaType }) {
  switch (type) {
    case 'image':
      return <ImageIcon className="w-4 h-4 text-[#2563EB]" />;
    case 'video':
      return <Film className="w-4 h-4 text-[#172554]" />;
    case 'audio':
      return <AudioWaveform className="w-4 h-4 text-[#16A34A]" />;
    case 'pdf':
      return <FileSearch className="w-4 h-4 text-[#0284C7]" />;
    default:
      return <FileText className="w-4 h-4 text-[#64748B]" />;
  }
}

export function HistoryView({
  mode,
  analyses,
  loading,
  onOpenAnalysis,
  onDeleteAnalysis,
  onStartUpload,
}: HistoryViewProps) {
  const [search, setSearch] = useState('');
  const [mediaFilter, setMediaFilter] = useState<'all' | MediaType>('all');
  const [classFilter, setClassFilter] = useState<'all' | Classification>('all');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return analyses.filter((item) => {
      if (
        mode === 'reports' &&
        item.status !== 'completed' &&
        item.status !== 'partially_completed'
      ) {
        return false;
      }
      if (mediaFilter !== 'all' && item.mediaType !== mediaFilter) return false;
      if (classFilter !== 'all' && item.scoring?.classification !== classFilter) return false;
      if (
        q &&
        !item.fileName.toLowerCase().includes(q) &&
        !item.id.toLowerCase().includes(q) &&
        !item.fileHash.toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
  }, [analyses, mode, mediaFilter, classFilter, search]);

  const title =
    mode === 'reports'
      ? 'Forensic Reports'
      : mode === 'history'
        ? 'Detection History'
        : 'My Analyses';

  const subtitle =
    mode === 'reports'
      ? 'Completed analyses with exportable PDF and JSON forensic reports.'
      : 'Persisted history stored on the TruthLens server. Deleting an analysis immediately purges any retained original media and extracted video frames.';

  const handleConfirmDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await onDeleteAnalysis(id);
    } finally {
      setDeletingId(null);
      setConfirmDeleteId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-[-0.02em] text-[#0F172A]">{title}</h1>
          <p className="mt-1 text-sm text-[#52607A] max-w-2xl">{subtitle}</p>
        </div>
        <PremiumButton
          variant="primary"
          size="md"
          onClick={onStartUpload}
        >
          <Upload className="w-3.5 h-3.5" />
          <span>New analysis</span>
        </PremiumButton>
      </div>

      {/* Filter Toolbar */}
      <div className="tl-glass-panel rounded-2xl p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-[#64748B] absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search filename, analysis ID, or SHA-256 hash…"
            className="w-full pl-9 pr-3 py-2 text-xs bg-white/80 border border-[#DCE8F8] rounded-xl text-[#0F172A] placeholder:text-[#64748B] focus:outline-none focus:border-[#7C3AED]"
          />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1 p-1 bg-[#EFF6FF]/75 border border-[#DCE8F8] rounded-xl overflow-x-auto">
            {MEDIA_FILTERS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setMediaFilter(tab.id)}
                className={`px-2.5 py-1 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  mediaFilter === tab.id
                    ? 'bg-white text-[#5B21B6] shadow-xs'
                    : 'text-[#52607A] hover:text-[#0F172A]'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <select
            aria-label="Filter by classification"
            value={classFilter}
            onChange={(e) => setClassFilter(e.target.value as 'all' | Classification)}
            className="px-3 py-1.5 text-xs bg-white/85 border border-[#DCE8F8] rounded-xl text-[#0F172A] focus:outline-none focus:border-[#7C3AED]"
          >
            {CLASSIFICATION_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {opt === 'all' ? 'All classifications' : opt}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Results Table */}
      <div className="tl-glass-panel rounded-2xl overflow-hidden">
        {loading ? (
          <div className="p-6 space-y-3">
            {[1, 2, 3, 4].map((n) => (
              <div key={n} className="h-12 bg-[#F5F7FB] rounded-lg animate-pulse" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-10 text-center">
            <p className="text-sm font-medium text-[#172554]">No matching analyses found</p>
            <p className="mt-1 text-xs text-[#64748B]">
              {analyses.length === 0
                ? 'Upload a media file to create your first persisted forensic report.'
                : 'Try adjusting your search query or media/classification filters.'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-[#DCE8F8]/80 bg-[#EFF6FF]/45 text-xs font-medium text-[#52607A]">
                  <th className="py-3 px-6">File &amp; Hash</th>
                  <th className="py-3 px-4">Media</th>
                  <th className="py-3 px-4 text-right">Estimate</th>
                  <th className="py-3 px-4">Classification</th>
                  <th className="py-3 px-4">Strength</th>
                  <th className="py-3 px-4">Uploaded</th>
                  <th className="py-3 px-6 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#DCE8F8]/70 text-sm">
                {filtered.map((item) => {
                  const tone = classificationTone(item.scoring?.classification);
                  const isConfirming = confirmDeleteId === item.id;

                  return (
                    <tr key={item.id} className="hover:bg-[#EFF6FF]/50 transition-colors">
                      <td
                        onClick={() => onOpenAnalysis(item)}
                        className="py-3.5 px-6 cursor-pointer"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <TypeIcon type={item.mediaType} />
                          <div className="min-w-0">
                            <p className="font-medium text-[#172554] truncate max-w-[240px]">
                              {item.fileName}
                            </p>
                            <p className="text-xs font-mono tabular-nums text-[#64748B]">
                              {item.id} · {formatBytes(item.fileSizeBytes)} ·{' '}
                              {item.fileHash.slice(0, 10)}…
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="py-3.5 px-4 text-xs text-[#64748B] whitespace-nowrap">
                        {mediaTypeLabel(item.mediaType)}
                      </td>
                      <td className="py-3.5 px-4 text-right font-mono tabular-nums font-semibold text-[#172554] whitespace-nowrap">
                        {(item.status === 'completed' || item.status === 'partially_completed') &&
                        item.scoring
                          ? `${item.scoring.aiLikelihoodScore}/100`
                          : item.status === 'needs_context'
                            ? 'Pending'
                            : item.status === 'processing'
                              ? 'Running'
                              : 'Failed'}
                      </td>
                      <td
                        className={`py-3.5 px-4 text-xs font-medium whitespace-nowrap ${
                          item.status === 'needs_context' ? 'text-[#6D28D9]' : tone.text
                        }`}
                      >
                        {item.status === 'completed'
                          ? `${item.scoring?.classification ?? 'Inconclusive'}${item.isUpdatedReport ? ' · Updated' : ''}`
                          : item.status === 'partially_completed'
                            ? `${item.scoring?.classification ?? 'Inconclusive'} · Partial`
                            : item.status === 'needs_context'
                              ? 'Follow-up needed'
                              : item.status === 'processing'
                                ? 'Processing'
                                : 'Failed'}
                      </td>
                      <td className="py-3.5 px-4 text-xs text-[#64748B] whitespace-nowrap">
                        {item.scoring?.evidenceStrength ?? '--'}
                      </td>
                      <td className="py-3.5 px-4 text-xs font-mono tabular-nums text-[#64748B] whitespace-nowrap">
                        {formatDateTime(item.uploadDate)}
                      </td>
                      <td className="py-3.5 px-6 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => onOpenAnalysis(item)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-[#2563EB] hover:bg-[#2563EB]/10 rounded-md transition-colors cursor-pointer"
                          >
                            Open
                            <ArrowUpRight className="w-3.5 h-3.5" />
                          </button>

                          {(item.status === 'completed' ||
                            item.status === 'partially_completed') && (
                            <button
                              type="button"
                              onClick={() => exportForensicPdfReport(item)}
                              title="Download PDF report"
                              className="p-1.5 text-[#64748B] hover:text-[#172554] hover:bg-[#F5F7FB] rounded-md transition-colors cursor-pointer"
                            >
                              <Download className="w-3.5 h-3.5" />
                            </button>
                          )}

                          {isConfirming ? (
                            <div className="inline-flex items-center gap-1.5 ml-1">
                              <button
                                type="button"
                                disabled={deletingId === item.id}
                                onClick={() => void handleConfirmDelete(item.id)}
                                className="px-2 py-1 text-xs font-medium text-white bg-[#DC2626] hover:bg-[#B91C1C] rounded-md cursor-pointer disabled:opacity-50"
                              >
                                {deletingId === item.id ? 'Deleting…' : 'Confirm'}
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteId(null)}
                                className="px-2 py-1 text-xs font-medium text-[#64748B] hover:text-[#172554] cursor-pointer"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteId(item.id)}
                              title="Delete analysis and purge files"
                              className="p-1.5 text-[#64748B] hover:text-[#DC2626] hover:bg-[#FEF2F2] rounded-md transition-colors cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
