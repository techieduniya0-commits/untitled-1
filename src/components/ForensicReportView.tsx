import { useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  Database,
  Download,
  ExternalLink,
  FileJson,
  Info,
  MessageSquarePlus,
  MinusCircle,
  Play,
  RefreshCw,
  ScanEye,
  ShieldAlert,
  Sparkles,
  Upload,
  UserCheck,
  XCircle,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { AnalysisRecord, DetectorResult, VideoFrameSample } from '../types/forensics';
import {
  buildPlainTextSummary,
  classificationTone,
  exportForensicPdfReport,
  formatBytes,
  formatDateTime,
  mediaTypeLabel,
} from '../lib/formatters';
import { FollowUpContextPanel } from './FollowUpContextPanel';

interface ForensicReportViewProps {
  analysis: AnalysisRecord;
  onBack: () => void;
  onNewUpload?: () => void;
  onSaveToDataset: (analysis: AnalysisRecord) => Promise<void>;
  onRetryAnalysis?: (id: string) => Promise<void>;
  onAnalysisUpdated?: (updated: AnalysisRecord) => void;
}

export function ForensicReportView({
  analysis,
  onBack,
  onNewUpload,
  onSaveToDataset,
  onRetryAnalysis,
  onAnalysisUpdated,
}: ForensicReportViewProps) {
  const [copied, setCopied] = useState(false);
  const [savedToDataset, setSavedToDataset] = useState(false);
  const [savingDataset, setSavingDataset] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [showFollowUpDrawer, setShowFollowUpDrawer] = useState(false);
  const [expandedDetectorId, setExpandedDetectorId] = useState<string | null>(null);
  const [selectedFrame, setSelectedFrame] = useState<VideoFrameSample | null>(
    analysis.videoFrames?.[0] ?? null,
  );
  const [mediaPreviewOpen, setMediaPreviewOpen] = useState(false);
  const [activeAudioSec, setActiveAudioSec] = useState<number | null>(null);
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);

  const scoring = analysis.scoring;
  const tone = classificationTone(scoring?.classification);
  const performedDetectors = analysis.detectors.filter(
    (d) =>
      d.status === 'completed' ||
      d.status === 'partially_implemented' ||
      d.status === 'partially_completed',
  );
  const failedDetectors = analysis.detectors.filter((d) => d.status === 'failed');
  const unavailableDetectors = analysis.detectors.filter(
    (d) => d.status === 'unavailable' || d.status === 'not_applicable' || d.status === 'skipped',
  );
  const isPartialReport = Boolean(
    analysis.isPartialReport ||
      analysis.status === 'partially_completed' ||
      failedDetectors.length > 0 ||
      analysis.geminiStatus === 'failed' ||
      analysis.geminiStatus === 'partially_completed',
  );

  const handleRetryGemini = async () => {
    if (!onRetryAnalysis) return;
    setRetrying(true);
    try {
      await onRetryAnalysis(analysis.id);
    } finally {
      setRetrying(false);
    }
  };

  const seekAudioSegment = (startSec: number) => {
    setActiveAudioSec(startSec);
    if (audioPlayerRef.current) {
      audioPlayerRef.current.currentTime = startSec;
      void audioPlayerRef.current.play().catch(() => {
        // Browser autoplay policy may require direct user interaction on audio element
      });
    }
  };

  const handleCopySummary = async () => {
    try {
      await navigator.clipboard.writeText(buildPlainTextSummary(analysis));
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    } catch {
      setCopied(false);
    }
  };

  const handleExportJson = () => {
    const blob = new Blob([JSON.stringify(analysis, null, 2)], {
      type: 'application/json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `truthlens-report-${analysis.id}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const handleSaveDataset = async () => {
    setSavingDataset(true);
    try {
      await onSaveToDataset(analysis);
      setSavedToDataset(true);
    } finally {
      setSavingDataset(false);
    }
  };

  const formatDetectorStatus = (status: DetectorResult['status']): { label: string; color: string } => {
    switch (status) {
      case 'completed':
        return { label: 'Completed', color: 'text-[#16A34A]' };
      case 'partially_completed':
        return { label: 'Partially completed', color: 'text-[#D97706]' };
      case 'partially_implemented':
        return { label: 'Partially implemented', color: 'text-[#D97706]' };
      case 'retrying':
        return { label: 'Retrying', color: 'text-[#2563EB]' };
      case 'failed':
        return { label: 'Failed (recoverable)', color: 'text-[#DC2626]' };
      case 'skipped':
        return { label: 'Skipped', color: 'text-[#64748B]' };
      case 'not_applicable':
        return { label: 'Not applicable', color: 'text-[#64748B]' };
      case 'pending':
        return { label: 'Pending', color: 'text-[#64748B]' };
      default:
        return { label: 'Unavailable', color: 'text-[#64748B]' };
    }
  };

  const renderDetectorRow = (det: DetectorResult) => {
    const isExpanded = expandedDetectorId === det.id;
    const statusMeta = formatDetectorStatus(det.status);
    return (
      <div key={det.id} className="border-b border-[#E5EAF2] last:border-b-0">
        <button
          type="button"
          onClick={() => setExpandedDetectorId(isExpanded ? null : det.id)}
          className="w-full px-6 py-4 text-left hover:bg-[#F5F7FB]/60 transition-colors flex flex-col md:flex-row md:items-center justify-between gap-3 cursor-pointer"
        >
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
              {det.status === 'completed' ? (
                <CheckCircle2 className="w-4 h-4 text-[#16A34A] shrink-0" />
              ) : det.status === 'partially_implemented' || det.status === 'partially_completed' ? (
                <AlertTriangle className="w-4 h-4 text-[#D97706] shrink-0" />
              ) : det.status === 'failed' ? (
                <XCircle className="w-4 h-4 text-[#DC2626] shrink-0" />
              ) : (
                <MinusCircle className="w-4 h-4 text-[#64748B] shrink-0" />
              )}
              <span className="text-sm font-semibold text-[#172554]">{det.methodName}</span>
              <span className="text-xs text-[#64748B]">·</span>
              <span className={`text-xs font-medium ${statusMeta.color}`}>{statusMeta.label}</span>
              {det.signalPolarity && det.ran && (
                <>
                  <span className="text-xs text-[#64748B]">·</span>
                  <span
                    className={`text-xs font-medium ${
                      det.signalPolarity === 'ai_indicator'
                        ? 'text-[#DC2626]'
                        : det.signalPolarity === 'natural_capture'
                          ? 'text-[#16A34A]'
                          : 'text-[#64748B]'
                    }`}
                  >
                    {det.signalPolarity === 'ai_indicator'
                      ? 'Supports AI'
                      : det.signalPolarity === 'natural_capture'
                        ? 'Supports natural capture'
                        : 'Neutral'}
                  </span>
                </>
              )}
              <span className="text-xs text-[#64748B]">·</span>
              <span className="text-xs text-[#64748B]">{det.calibrationStatus}</span>
              <span className="text-xs text-[#64748B]">·</span>
              <span className="text-xs text-[#64748B]">{det.reliability} reliability</span>
              {det.durationMs !== undefined && (
                <>
                  <span className="text-xs text-[#64748B]">·</span>
                  <span className="text-xs font-mono tabular-nums text-[#64748B]">
                    {det.durationMs} ms
                  </span>
                </>
              )}
              {det.detectorVersion && (
                <>
                  <span className="text-xs text-[#64748B]">·</span>
                  <span className="text-xs font-mono text-[#64748B]">v{det.detectorVersion}</span>
                </>
              )}
            </div>
            <p className="mt-1 text-xs text-[#64748B] leading-relaxed">{det.resultSummary}</p>
          </div>

          <div className="flex items-center gap-4 shrink-0">
            <div className="text-right">
              <p className="text-xs font-mono tabular-nums font-semibold text-[#172554]">
                {det.status === 'unavailable'
                  ? 'Not performed'
                  : det.status === 'not_applicable'
                    ? 'Not applicable'
                    : det.status === 'failed'
                      ? 'Failed'
                      : det.status === 'skipped'
                        ? 'Skipped'
                        : det.rawSignalScore !== null
                          ? `${det.rawSignalScore}/100`
                          : 'Informational'}
              </p>
              <p className="text-[11px] text-[#64748B]">{det.toolUsed}</p>
            </div>
            {isExpanded ? (
              <ChevronUp className="w-4 h-4 text-[#64748B]" />
            ) : (
              <ChevronDown className="w-4 h-4 text-[#64748B]" />
            )}
          </div>
        </button>

        {isExpanded && (
          <div className="px-6 pb-5 pt-1 bg-[#F5F7FB]/50 grid grid-cols-1 md:grid-cols-2 gap-5 text-xs">
            <div>
              <p className="font-semibold text-[#172554] mb-1.5">Observed Evidence</p>
              <ul className="space-y-1 text-[#64748B] list-disc pl-4">
                {det.evidence.length > 0 ? (
                  det.evidence.map((ev, i) => <li key={i}>{ev}</li>)
                ) : (
                  <li>No additional structured observations recorded.</li>
                )}
              </ul>
              <p className="mt-2.5 text-[#64748B]">
                <span className="font-medium text-[#172554]">Applicability:</span>{' '}
                {det.applicability} ·{' '}
                <span className="font-medium text-[#172554]">Correlation group:</span>{' '}
                <span className="font-mono">{det.correlationGroup}</span>
              </p>
            </div>
            <div>
              <p className="font-semibold text-[#172554] mb-1.5">Method Limitations</p>
              <ul className="space-y-1 text-[#64748B] list-disc pl-4">
                {det.limitations.length > 0 ? (
                  det.limitations.map((lim, i) => <li key={i}>{lim}</li>)
                ) : (
                  <li>Standard forensic interpretation limits apply.</li>
                )}
              </ul>
            </div>
          </div>
        )}
      </div>
    );
  };

  // Build clean metadata key/value rows
  const metadataRows: Array<[string, string]> = [];
  if (analysis.metadata) {
    const m = analysis.metadata;
    metadataRows.push(['File Name', m.fileName]);
    metadataRows.push(['Verified MIME Type', m.detectedMime]);
    metadataRows.push(['File Size', `${formatBytes(m.fileSizeBytes)} (${m.fileSizeBytes.toLocaleString()} bytes)`]);
    metadataRows.push(['SHA-256 Hash', m.sha256]);
    metadataRows.push(['Metadata Present', m.metadataPresent ? 'Yes' : 'No']);
    metadataRows.push(['C2PA Provenance', `${m.c2paStatus} — ${m.c2paDetails ?? 'No manifest'}`]);

    if (analysis.mediaType === 'image') {
      metadataRows.push(['Dimensions', m.width && m.height ? `${m.width} × ${m.height} px` : 'Not available']);
      metadataRows.push(['Color Mode / Channels', `${m.colorMode ?? 'Unknown'} (${m.channels ?? '?'} ch)`]);
      metadataRows.push(['Camera Make / Model', [m.cameraMake, m.cameraModel].filter(Boolean).join(' ') || 'Not present']);
      metadataRows.push(['Software / Creator Tool', m.software || 'Not present']);
      metadataRows.push(['ICC Profile', m.iccProfile || 'Not present']);
      metadataRows.push(['GPS Information', m.gpsSummary || 'Not present']);
      metadataRows.push(['Creation Timestamp', m.createdAt || 'Not present']);
      metadataRows.push(['Modification Timestamp', m.modifiedAt || 'Not present']);
    } else if (analysis.mediaType === 'video') {
      metadataRows.push(['Container Format', m.containerFormat || 'Not available']);
      metadataRows.push(['Video Codec', m.videoCodec || 'Not available']);
      metadataRows.push(['Audio Codec', m.audioCodec || 'None detected']);
      metadataRows.push(['Resolution', m.width && m.height ? `${m.width} × ${m.height}` : 'Not available']);
      metadataRows.push(['Duration', m.durationSeconds ? `${m.durationSeconds} seconds` : 'Not available']);
      metadataRows.push(['Frame Rate', m.frameRate ? `${m.frameRate} fps` : 'Not available']);
      metadataRows.push(['Video Bitrate', m.videoBitrate ? `${Math.round(m.videoBitrate / 1000)} kbps` : 'Not available']);
      metadataRows.push(['Frame Count', m.frameCount ? String(m.frameCount) : 'Not available']);
      metadataRows.push(['Encoder', m.encoder || 'Not present']);
    } else if (analysis.mediaType === 'audio') {
      metadataRows.push(['Audio Format / Codec', `${m.audioFormat || 'Unknown'} / ${m.codec || 'Unknown'}`]);
      metadataRows.push(['Duration', m.durationSeconds ? `${m.durationSeconds} seconds` : 'Not available']);
      metadataRows.push(['Sample Rate', m.sampleRate ? `${m.sampleRate} Hz` : 'Not available']);
      metadataRows.push(['Bitrate', m.bitrate ? `${Math.round(m.bitrate / 1000)} kbps` : 'Not available']);
      metadataRows.push(['Channels', m.audioChannels ? String(m.audioChannels) : 'Not available']);
      metadataRows.push(['Encoder', m.encoder || 'Not present']);
    } else {
      metadataRows.push(['Title', m.title || 'Not present']);
      metadataRows.push(['Author', m.author || 'Not present']);
      metadataRows.push(['Creator / Producer', [m.creator, m.producer].filter(Boolean).join(' / ') || 'Not present']);
      metadataRows.push(['Creation Date', m.creationDate || 'Not present']);
      metadataRows.push(['Modification Date', m.modificationDate || 'Not present']);
      if (m.pageCount !== undefined && m.pageCount !== null) {
        metadataRows.push(['Page Count', String(m.pageCount)]);
      }
      metadataRows.push(['Word Count', m.wordCount !== undefined && m.wordCount !== null ? String(m.wordCount) : '0']);
      metadataRows.push(['Embedded Images', String(m.embeddedImageCount ?? 0)]);
      if (m.fonts?.length) {
        metadataRows.push(['Declared Fonts', m.fonts.slice(0, 10).join(', ')]);
      }
      metadataRows.push(['Document Structure', m.documentStructure || 'Standard']);
    }
  }

  return (
    <div className="space-y-6 pb-12">
      {/* Top Action Bar */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          <button
            type="button"
            onClick={onBack}
            className="mt-0.5 p-2 text-[#64748B] hover:text-[#172554] bg-white border border-[#E5EAF2] rounded-lg transition-colors shrink-0 cursor-pointer"
            aria-label="Back to analyses"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs font-mono tabular-nums text-[#64748B]">
              <span>{analysis.id}</span>
              <span aria-hidden="true">·</span>
              <span>{mediaTypeLabel(analysis.mediaType)}</span>
              <span aria-hidden="true">·</span>
              <span>{formatBytes(analysis.fileSizeBytes)}</span>
              <span aria-hidden="true">·</span>
              <span>{formatDateTime(analysis.completedDate || analysis.uploadDate)}</span>
            </div>
            <h1 className="mt-1 text-xl sm:text-2xl font-bold tracking-[-0.02em] text-[#172554] truncate">
              {analysis.fileName}
            </h1>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {onAnalysisUpdated && (
            <button
              type="button"
              onClick={() => setShowFollowUpDrawer((v) => !v)}
              className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                showFollowUpDrawer
                  ? 'bg-[#F3F0FF] text-[#5B21B6] border-[#C4B5FD]'
                  : 'text-[#5B21B6] bg-white hover:bg-[#F5F3FF] border-[#DDD6FE]'
              }`}
            >
              <MessageSquarePlus className="w-3.5 h-3.5" />
              {analysis.isUpdatedReport ? 'Update context & reanalyse' : 'Add context & reanalyse'}
            </button>
          )}
          {onNewUpload && (
            <button
              type="button"
              onClick={onNewUpload}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-[#172554] bg-white hover:bg-[#F5F7FB] border border-[#E5EAF2] rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Upload className="w-3.5 h-3.5" />
              New upload
            </button>
          )}
          <button
            type="button"
            onClick={() => exportForensicPdfReport(analysis)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-[#2563EB] hover:bg-[#1D4ED8] rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            Download PDF
          </button>
          <button
            type="button"
            onClick={handleExportJson}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-[#172554] bg-white hover:bg-[#F5F7FB] border border-[#E5EAF2] rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <FileJson className="w-3.5 h-3.5" />
            Export JSON
          </button>
          <button
            type="button"
            onClick={() => void handleCopySummary()}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-[#172554] bg-white hover:bg-[#F5F7FB] border border-[#E5EAF2] rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-[#16A34A]" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? 'Copied summary' : 'Copy summary'}
          </button>
          {analysis.mediaRetained && analysis.previewUrl && (
            <button
              type="button"
              onClick={() => setMediaPreviewOpen((v) => !v)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-[#172554] bg-white hover:bg-[#F5F7FB] border border-[#E5EAF2] rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              {mediaPreviewOpen ? 'Hide original file' : 'View original file'}
            </button>
          )}
          <button
            type="button"
            disabled={savingDataset || savedToDataset}
            onClick={() => void handleSaveDataset()}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-[#172554] bg-white hover:bg-[#F5F7FB] border border-[#E5EAF2] rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
          >
            <Database className="w-3.5 h-3.5" />
            {savedToDataset ? 'Logged to Dataset' : savingDataset ? 'Logging…' : 'Log to Dataset'}
          </button>
        </div>
      </div>

      {/* Optional Follow-Up Context Drawer */}
      {showFollowUpDrawer && (
        <FollowUpContextPanel
          record={analysis}
          mode="optional"
          onCancel={() => setShowFollowUpDrawer(false)}
          onReanalysisComplete={(updated) => {
            setShowFollowUpDrawer(false);
            onAnalysisUpdated?.(updated);
          }}
        />
      )}

      {/* Partial Forensic Report Disclosure Banner */}
      {isPartialReport && (
        <div
          role="status"
          className="bg-[#FFFBEB] border border-[#FDE68A] rounded-xl p-5 flex flex-col lg:flex-row lg:items-start justify-between gap-4"
        >
          <div className="flex items-start gap-3 min-w-0">
            <AlertTriangle className="w-5 h-5 text-[#D97706] shrink-0 mt-0.5" />
            <div className="space-y-1 text-xs">
              <p className="text-sm font-semibold text-[#92400E]">
                Partial Forensic Report — Gemini Analysis{' '}
                {analysis.geminiStatus === 'partially_completed'
                  ? 'Partially Completed'
                  : 'Did Not Complete'}
              </p>
              <p className="leading-relaxed text-[#92400E]/90">
                {performedDetectors.length} independent detector(s) completed,{' '}
                {failedDetectors.length} Gemini-backed detector(s) failed due to temporary upstream
                unavailability, and {unavailableDetectors.length} method(s) are unavailable/not
                applicable. Failed API checks were excluded from scoring and are never treated as
                evidence of AI generation.
              </p>
              {analysis.geminiFailureDetail && (
                <p className="font-mono text-[11px] text-[#92400E]/80 break-words">
                  Upstream status: {analysis.geminiFailureDetail}
                </p>
              )}
            </div>
          </div>

          {analysis.canRetryGemini && onRetryAnalysis && (
            <button
              type="button"
              disabled={retrying}
              onClick={() => void handleRetryGemini()}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-[#172554] hover:bg-[#1E3A8A] rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${retrying ? 'animate-spin' : ''}`} />
              {retrying
                ? 'Retrying…'
                : analysis.mediaType === 'video' && analysis.videoFrames?.length
                  ? 'Retry Gemini (Reuse Cached Frames)'
                  : 'Retry Gemini Analysis'}
            </button>
          )}
        </div>
      )}

      {/* Original File Inline Drawer (avoids window.open in iframe) */}
      {mediaPreviewOpen && analysis.mediaRetained && analysis.previewUrl && (
        <div className="tl-glass-panel rounded-2xl p-5">
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-semibold text-[#172554]">
              Retained Original File Preview (Read-only, non-executable)
            </p>
            <a
              href={`${analysis.previewUrl}?download=1`}
              download={analysis.fileName}
              className="text-xs font-medium text-[#2563EB] hover:underline"
            >
              Download original file
            </a>
          </div>
          {analysis.mediaType === 'image' && (
            <img
              src={analysis.previewUrl}
              alt={analysis.fileName}
              className="max-h-[420px] rounded-lg border border-[#E5EAF2] mx-auto object-contain"
            />
          )}
          {analysis.mediaType === 'video' && (
            <video
              src={analysis.previewUrl}
              controls
              className="max-h-[420px] w-full rounded-lg border border-[#E5EAF2] bg-black"
            />
          )}
          {analysis.mediaType === 'audio' && (
            <audio src={analysis.previewUrl} controls className="w-full" />
          )}
          {(analysis.mediaType === 'pdf' || analysis.mediaType === 'document') && (
            <p className="text-xs text-[#64748B]">
              Document preview is displayed statically in the extracted text panel below for safety.
              Use the download link above to save the original bytes.
            </p>
          )}
        </div>
      )}

      {/* Primary Score & Classification Summary Card */}
      {scoring && (
        <div className="tl-glass-panel rounded-2xl p-6">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-center">
            <div className="lg:col-span-5">
              <p className="text-xs font-medium text-[#64748B]">{scoring.calibrationLabel}</p>
              <div className="mt-2 flex items-baseline gap-3">
                <span className="text-4xl font-bold font-mono tabular-nums text-[#172554]">
                  {scoring.aiLikelihoodScore}
                </span>
                <span className="text-sm font-mono text-[#64748B]">/ 100</span>
                <span className={`text-base font-semibold ${tone.text}`}>
                  {scoring.classification}
                </span>
              </div>
              <div className="mt-3 h-2.5 w-full bg-[#F5F7FB] rounded-full overflow-hidden border border-[#E5EAF2]">
                <div
                  className={`h-full ${tone.bar} transition-all duration-300`}
                  style={{ width: `${scoring.aiLikelihoodScore}%` }}
                />
              </div>
              <div className="mt-2 flex justify-between text-[11px] font-mono text-[#64748B]">
                <span>0 · Likely human-created</span>
                <span>50 · Inconclusive</span>
                <span>100 · Likely AI</span>
              </div>
            </div>

            <div className="lg:col-span-7 grid grid-cols-2 sm:grid-cols-3 gap-4 lg:border-l lg:border-[#E5EAF2] lg:pl-6">
              <div>
                <p className="text-xs text-[#64748B]">Evidence strength</p>
                <p className="mt-1 text-lg font-bold text-[#172554]">{scoring.evidenceStrength}</p>
                <p className="mt-0.5 text-[11px] text-[#64748B]">Independent from score</p>
              </div>
              <div>
                <p className="text-xs text-[#64748B]">Overall reliability</p>
                <p className="mt-1 text-lg font-bold text-[#172554]">
                  {scoring.overallReliability ?? 'Moderate'}
                </p>
                <p className="mt-0.5 text-[11px] font-mono tabular-nums text-[#64748B]">
                  {scoring.completenessPercent !== undefined
                    ? `${scoring.completenessPercent}% pipeline completeness`
                    : 'Correlated decay applied'}
                </p>
              </div>
              <div>
                <p className="text-xs text-[#64748B]">Methods run / failed / unavail.</p>
                <p className="mt-1 text-lg font-bold font-mono tabular-nums text-[#172554]">
                  <span className="text-[#16A34A]">{scoring.methodsPerformedCount}</span>
                  <span className="text-[#64748B] font-normal"> / </span>
                  <span className={scoring.methodsFailedCount > 0 ? 'text-[#DC2626]' : 'text-[#64748B] font-normal'}>
                    {scoring.methodsFailedCount}
                  </span>
                  <span className="text-[#64748B] font-normal"> / {scoring.methodsUnavailableCount}</span>
                </p>
                <p className="mt-0.5 text-[11px] text-[#64748B]">
                  {scoring.conflictingFindings.length} conflict
                  {scoring.conflictingFindings.length === 1 ? '' : 's'} · Gemini:{' '}
                  {analysis.geminiStatus ?? 'completed'}
                </p>
              </div>
            </div>
          </div>

          {analysis.duplicateOfAnalysisId && (
            <div className="mt-4 pt-3 border-t border-[#E5EAF2] flex items-start gap-2.5 text-xs text-[#172554]">
              <Info className="w-4 h-4 text-[#2563EB] shrink-0 mt-0.5" />
              <p>
                <strong>Duplicate SHA-256 hash detected:</strong> Identical file bytes were
                previously analysed under report{' '}
                <span className="font-mono font-semibold">{analysis.duplicateOfAnalysisId}</span>.
                This run was executed independently for audit verification.
              </p>
            </div>
          )}

          <div className="mt-4 pt-4 border-t border-[#E5EAF2] flex items-start gap-2.5 text-xs text-[#64748B]">
            <Info className="w-4 h-4 text-[#2563EB] shrink-0 mt-0.5" />
            <p>
              <strong>Important interpretation notice:</strong> A detection score is an experimental
              estimate, not definitive proof of authorship or authenticity. Always corroborate
              high-stakes decisions with provenance checks, original source verification, and human
              review.
            </p>
          </div>
        </div>
      )}

      {/* Updated Report & Reanalysis Transparency Section (Original vs Updated + Separated User Context) */}
      {analysis.isUpdatedReport && analysis.reanalysisSummary && analysis.userContext && (
        <div className="tl-glass-panel rounded-2xl overflow-hidden border-[#C4B5FD]/80">
          <div className="px-6 py-4 bg-gradient-to-r from-[#EFF6FF]/85 via-[#F5F3FF]/85 to-white border-b border-[#DDD6FE]/80 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-[#2563EB] to-[#7C3AED] flex items-center justify-center text-white shrink-0 mt-0.5">
                <Sparkles className="w-4 h-4" />
              </div>
              <div>
                <h2 className="text-base font-bold text-[#172554]">
                  Updated Forensic Report — Reanalysis &amp; User Context Disclosure
                </h2>
                <p className="text-xs text-[#52607A] mt-0.5">
                  Updated {formatDateTime(analysis.reanalysisSummary.updatedAt)} · Preserves
                  original automated findings alongside your submitted context and statement.
                </p>
              </div>
            </div>
            <span className="text-[11px] font-mono uppercase tracking-wider font-semibold text-[#5B21B6] bg-white/90 border border-[#DDD6FE] rounded-lg px-2.5 py-1 whitespace-nowrap self-start sm:self-center">
              Updated Report
            </span>
          </div>

          <div className="p-6 space-y-6">
            {/* Original vs Updated Comparison Grid */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="rounded-xl bg-[#F8FAFF] border border-[#DCE8F8] p-4">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-[#52607A]">
                  AI-Likelihood Score
                </p>
                <div className="mt-2 flex items-center gap-2 font-mono tabular-nums text-sm">
                  <span className="text-[#64748B]">
                    {analysis.reanalysisSummary.scoreBefore}/100
                  </span>
                  <ArrowRight className="w-3.5 h-3.5 text-[#7C3AED]" />
                  <span className="font-bold text-[#172554] text-base">
                    {analysis.reanalysisSummary.scoreAfter}/100
                  </span>
                  <span className="text-xs text-[#64748B]">
                    (
                    {analysis.reanalysisSummary.scoreDelta === 0
                      ? 'no change'
                      : `${analysis.reanalysisSummary.scoreDelta > 0 ? '+' : ''}${analysis.reanalysisSummary.scoreDelta}`}
                    )
                  </span>
                </div>
              </div>

              <div className="rounded-xl bg-[#F8FAFF] border border-[#DCE8F8] p-4">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-[#52607A]">
                  Classification
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
                  <span className="text-[#64748B]">
                    {analysis.reanalysisSummary.classificationBefore}
                  </span>
                  <ArrowRight className="w-3.5 h-3.5 text-[#7C3AED] shrink-0" />
                  <span className="font-semibold text-[#172554]">
                    {analysis.reanalysisSummary.classificationAfter}
                  </span>
                </div>
              </div>

              <div className="rounded-xl bg-[#F8FAFF] border border-[#DCE8F8] p-4">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-[#52607A]">
                  Evidence Strength
                </p>
                <div className="mt-2 flex items-center gap-2 text-xs">
                  <span className="text-[#64748B]">
                    {analysis.reanalysisSummary.evidenceStrengthBefore}
                  </span>
                  <ArrowRight className="w-3.5 h-3.5 text-[#7C3AED]" />
                  <span className="font-semibold text-[#172554]">
                    {analysis.reanalysisSummary.evidenceStrengthAfter}
                  </span>
                </div>
              </div>
            </div>

            {/* Confidence Adjustment Justification */}
            <div className="rounded-xl bg-[#EFF6FF]/70 border border-[#BFDBFE] p-4 text-xs text-[#1E3A8A] leading-relaxed">
              <span className="font-semibold">Confidence score basis: </span>
              {analysis.reanalysisSummary.adjustmentJustification}
            </div>

            {/* Two-Column Split: Original Automated Findings + What Changed vs User-Provided Context */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
              {/* Left: Objective Original Findings & Delta */}
              <div className="lg:col-span-6 space-y-4">
                <div className="rounded-xl bg-white/90 border border-[#DCE8F8] p-4 space-y-2">
                  <p className="text-xs font-semibold text-[#172554]">
                    What Changed Between Original and Updated Analysis
                  </p>
                  <ul className="space-y-1.5 text-xs text-[#52607A] list-disc pl-4 leading-relaxed">
                    {analysis.reanalysisSummary.whatChanged.map((item, idx) => (
                      <li key={idx}>{item}</li>
                    ))}
                  </ul>
                </div>

                {analysis.originalSnapshot && (
                  <div className="rounded-xl bg-[#F8FAFC] border border-[#E2E8F0] p-4 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-semibold text-[#172554]">
                        Original Automated Analysis Snapshot
                      </p>
                      <span className="text-[11px] font-mono text-[#64748B]">
                        {formatDateTime(analysis.originalSnapshot.capturedAt)}
                      </span>
                    </div>
                    <p className="text-xs text-[#52607A] leading-relaxed">
                      {analysis.originalSnapshot.executiveSummary}
                    </p>
                    <p className="text-[11px] font-mono text-[#64748B] pt-1">
                      Original automated counts:{' '}
                      {analysis.originalSnapshot.evidenceSupportingAi.length} AI-supporting ·{' '}
                      {analysis.originalSnapshot.evidenceSupportingNaturalCapture.length}{' '}
                      natural-capture · {analysis.originalSnapshot.conflictingFindings.length}{' '}
                      conflicts
                    </p>
                  </div>
                )}
              </div>

              {/* Right: Strictly Separated User-Provided Context & Statement */}
              <div className="lg:col-span-6 rounded-xl bg-[#FAF5FF]/90 border border-[#DDD6FE] p-5 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <UserCheck className="w-4 h-4 text-[#6D28D9]" />
                    <h3 className="text-xs font-bold uppercase tracking-wide text-[#4C1D95]">
                      User-Provided Context &amp; Statement
                    </h3>
                  </div>
                  <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-[#6D28D9] bg-white border border-[#DDD6FE] rounded-md px-2 py-0.5">
                    <ShieldAlert className="w-3 h-3" />
                    Not independently verified evidence
                  </span>
                </div>

                {analysis.userContext.answers.length > 0 && (
                  <div className="space-y-2.5">
                    <p className="text-[11px] font-semibold text-[#5B21B6]">
                      Follow-Up Responses Provided by User
                    </p>
                    <div className="space-y-2">
                      {analysis.userContext.answers.map((ans) => (
                        <div
                          key={ans.questionId}
                          className="rounded-lg bg-white/90 border border-[#E9D5FF] px-3.5 py-2.5 text-xs"
                        >
                          <p className="font-medium text-[#52607A]">{ans.question}</p>
                          <p className="mt-1 font-semibold text-[#172554]">{ans.answer}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {analysis.userContext.userStatement && (
                  <div className="space-y-1.5">
                    <p className="text-[11px] font-semibold text-[#5B21B6]">
                      User Statement (Verbatim — User-Reported)
                    </p>
                    <blockquote className="rounded-lg bg-white/95 border-l-3 border-[#7C3AED] px-3.5 py-2.5 text-xs text-[#172554] leading-relaxed whitespace-pre-wrap">
                      “{analysis.userContext.userStatement}”
                    </blockquote>
                  </div>
                )}

                <p className="text-[11px] leading-relaxed text-[#5B21B6]/90 pt-2 border-t border-[#E9D5FF]">
                  <strong>Evidentiary boundary:</strong>{' '}
                  {analysis.reanalysisSummary.epistemicSeparationNote}
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Conflicting Findings & Disagreement Explanation Banner (if present) */}
      {scoring && scoring.conflictingFindings.length > 0 && (
        <div className="bg-[#FFFBEB] border border-[#FDE68A] rounded-xl p-5 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-[#D97706] shrink-0 mt-0.5" />
          <div className="space-y-2">
            <h2 className="text-sm font-semibold text-[#92400E]">
              Conflicting Detector Findings Observed
            </h2>
            <ul className="space-y-1 text-xs text-[#92400E]/90 list-disc pl-4">
              {scoring.conflictingFindings.map((cf, i) => (
                <li key={i}>{cf}</li>
              ))}
            </ul>
            {scoring.disagreementReasons && scoring.disagreementReasons.length > 0 && (
              <div className="pt-2 border-t border-[#FDE68A]">
                <p className="text-xs font-semibold text-[#92400E]">Why detectors disagreed</p>
                <ul className="mt-1 space-y-1 text-xs text-[#92400E]/90 list-disc pl-4">
                  {scoring.disagreementReasons.map((reason, i) => (
                    <li key={i}>{reason}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Separated Evidence Breakdown: AI-Supporting vs Natural Capture vs Neutral */}
      {scoring && (
        <div className="tl-glass-panel rounded-2xl overflow-hidden">
          <div className="px-6 py-4 border-b border-[#E5EAF2]">
            <h2 className="text-base font-semibold text-[#172554]">
              Evidentiary Breakdown by Direction
            </h2>
            <p className="text-xs text-[#64748B] mt-0.5">
              TruthLens separates positive AI indicators from natural-capture cues and neutral
              contextual checks (such as absent watermarks or re-encoding) to prevent false
              positives on authentic camera footage.
            </p>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-3 divide-y lg:divide-y-0 lg:divide-x divide-[#E5EAF2]">
            <div className="p-5">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-xs font-semibold text-[#DC2626]">
                  Evidence Supporting AI Generation
                </h3>
                <span className="text-xs font-mono tabular-nums text-[#64748B]">
                  {scoring.evidenceSupportingAi?.length ?? 0}
                </span>
              </div>
              <ul className="mt-3 space-y-2 text-xs leading-relaxed text-[#64748B] list-disc pl-4">
                {scoring.evidenceSupportingAi && scoring.evidenceSupportingAi.length > 0 ? (
                  scoring.evidenceSupportingAi.map((item, idx) => <li key={idx}>{item}</li>)
                ) : (
                  <li>No concrete AI-generation or deepfake indicators were flagged by completed detectors.</li>
                )}
              </ul>
            </div>

            <div className="p-5">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-xs font-semibold text-[#16A34A]">
                  Evidence Supporting Natural Capture
                </h3>
                <span className="text-xs font-mono tabular-nums text-[#64748B]">
                  {scoring.evidenceSupportingNaturalCapture?.length ?? 0}
                </span>
              </div>
              <ul className="mt-3 space-y-2 text-xs leading-relaxed text-[#64748B] list-disc pl-4">
                {scoring.evidenceSupportingNaturalCapture &&
                scoring.evidenceSupportingNaturalCapture.length > 0 ? (
                  scoring.evidenceSupportingNaturalCapture.map((item, idx) => (
                    <li key={idx}>{item}</li>
                  ))
                ) : (
                  <li>No explicit natural camera-capture signals were recorded.</li>
                )}
              </ul>
            </div>

            <div className="p-5">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-xs font-semibold text-[#475569]">Neutral Observations</h3>
                <span className="text-xs font-mono tabular-nums text-[#64748B]">
                  {scoring.neutralObservations?.length ?? 0}
                </span>
              </div>
              <ul className="mt-3 space-y-2 text-xs leading-relaxed text-[#64748B] list-disc pl-4">
                {scoring.neutralObservations && scoring.neutralObservations.length > 0 ? (
                  scoring.neutralObservations.slice(0, 6).map((item, idx) => (
                    <li key={idx}>{item}</li>
                  ))
                ) : (
                  <li>No neutral contextual notes recorded.</li>
                )}
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* MEDIA-SPECIFIC VISUAL / TIMELINE / DOCUMENT / AUDIO INSPECTION PANEL */}
      {analysis.mediaType === 'image' && analysis.imageVisualMetrics && (
        <div className="tl-glass-panel rounded-2xl p-6">
          <h2 className="text-base font-semibold text-[#172554] mb-4">
            Visual &amp; Pixel-Level Inspection Panel
          </h2>
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-5">
              <div className="rounded-lg border border-[#E5EAF2] bg-[#F5F7FB] overflow-hidden aspect-[4/3] flex items-center justify-center">
                {analysis.mediaRetained && analysis.previewUrl ? (
                  <img
                    src={analysis.previewUrl}
                    alt={analysis.fileName}
                    className="w-full h-full object-contain"
                  />
                ) : (
                  <span className="text-xs text-[#64748B]">Original media purged per retention policy</span>
                )}
              </div>
              <p className="mt-2 text-xs font-mono tabular-nums text-[#64748B]">
                Aspect &amp; Resolution: {analysis.imageVisualMetrics.aspectRatio}
              </p>
            </div>

            <div className="lg:col-span-7 space-y-5">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3.5">
                {[
                  ['Laplacian Noise Var', String(analysis.imageVisualMetrics.laplacianVariance)],
                  [
                    'Quadrant Spread',
                    `${(analysis.imageVisualMetrics.quadrantNoiseSpread * 100).toFixed(1)}%`,
                  ],
                  ['ELA Mean Diff (Q90)', `${analysis.imageVisualMetrics.elaMeanDiff} (max ${analysis.imageVisualMetrics.elaMaxDiff})`],
                  ...(analysis.imageVisualMetrics.doubleCompressionDelta !== undefined
                    ? [
                        [
                          'Double-JPEG Delta (Q90/Q75)',
                          String(analysis.imageVisualMetrics.doubleCompressionDelta),
                        ],
                      ]
                    : []),
                  ['High-Freq Energy', String(analysis.imageVisualMetrics.highFreqEnergyRatio)],
                  ['Edge Density', `${(analysis.imageVisualMetrics.edgeDensity * 100).toFixed(1)}%`],
                  [
                    'RGB Entropy',
                    `${analysis.imageVisualMetrics.channelEntropy.r} / ${analysis.imageVisualMetrics.channelEntropy.g} / ${analysis.imageVisualMetrics.channelEntropy.b}`,
                  ],
                ].map(([label, val]) => (
                  <div key={label} className="bg-[#F5F7FB] border border-[#E5EAF2] rounded-lg p-3">
                    <p className="text-[11px] text-[#64748B]">{label}</p>
                    <p className="mt-1 text-sm font-semibold font-mono tabular-nums text-[#172554]">
                      {val}
                    </p>
                  </div>
                ))}
              </div>

              {analysis.imageVisualMetrics.suspiciousRegions.length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold text-[#172554] mb-2">
                    Inspected Image Regions &amp; Observations
                  </h3>
                  <div className="divide-y divide-[#E5EAF2] border border-[#E5EAF2] rounded-lg">
                    {analysis.imageVisualMetrics.suspiciousRegions.map((reg, idx) => (
                      <div key={idx} className="px-4 py-2.5 text-xs">
                        <span className="font-semibold text-[#172554]">{reg.label}</span>
                        <span className="text-[#64748B]"> · {reg.region}</span>
                        <p className="mt-0.5 text-[#64748B]">{reg.observation}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {analysis.imageVisualMetrics.ocrExtractedText.length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold text-[#172554] mb-1">
                    OCR Recognized Text
                  </h3>
                  <p className="text-xs font-mono text-[#64748B] bg-[#F5F7FB] border border-[#E5EAF2] rounded-lg p-3">
                    {analysis.imageVisualMetrics.ocrExtractedText.join('  |  ')}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {analysis.mediaType === 'video' && analysis.videoFrames && (
        <div className="tl-glass-panel rounded-2xl p-6 space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold text-[#172554]">
                Timestamped Video Frame Timeline
              </h2>
              <p className="mt-0.5 text-xs text-[#64748B]">
                {analysis.videoSamplingStrategy || 'Uniform multi-frame extraction via FFmpeg.'}
              </p>
            </div>
          </div>

          {analysis.videoTelemetry && (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
              <div className="bg-[#F5F7FB] border border-[#E5EAF2] rounded-lg p-3">
                <p className="text-[11px] text-[#64748B]">Frame Sampling Disclosure</p>
                <p className="mt-1 text-sm font-semibold font-mono tabular-nums text-[#172554]">
                  {analysis.videoTelemetry.extractedFramesCount} extracted /{' '}
                  {analysis.videoTelemetry.totalFramesEstimated ?? '?'} total
                </p>
                <p className="mt-0.5 text-[11px] font-mono tabular-nums text-[#64748B]">
                  {analysis.videoTelemetry.skippedFramesEstimated ?? '?'} skipped ·{' '}
                  {analysis.videoTelemetry.intervalSeconds}s interval
                </p>
              </div>
              <div className="bg-[#F5F7FB] border border-[#E5EAF2] rounded-lg p-3">
                <p className="text-[11px] text-[#64748B]">Histogram Similarity (Bhattacharyya)</p>
                <p className="mt-1 text-sm font-semibold font-mono tabular-nums text-[#172554]">
                  {analysis.videoTelemetry.meanHistogramSimilarity !== null
                    ? analysis.videoTelemetry.meanHistogramSimilarity.toFixed(4)
                    : 'N/A'}
                </p>
                <p className="mt-0.5 text-[11px] text-[#64748B]">Mean inter-frame luma correlation</p>
              </div>
              <div className="bg-[#F5F7FB] border border-[#E5EAF2] rounded-lg p-3">
                <p className="text-[11px] text-[#64748B]">GOP Frame Counts (FFprobe)</p>
                <p className="mt-1 text-sm font-semibold font-mono tabular-nums text-[#172554]">
                  {analysis.videoTelemetry.gopCounts
                    ? `I:${analysis.videoTelemetry.gopCounts.I} · P:${analysis.videoTelemetry.gopCounts.P} · B:${analysis.videoTelemetry.gopCounts.B}`
                    : 'Not available'}
                </p>
                <p className="mt-0.5 text-[11px] text-[#64748B]">Inspected stream packets</p>
              </div>
              <div className="bg-[#F5F7FB] border border-[#E5EAF2] rounded-lg p-3">
                <p className="text-[11px] text-[#64748B]">GOP Sequence / Delta Var</p>
                <p className="mt-1 text-xs font-semibold font-mono text-[#172554] truncate">
                  {analysis.videoTelemetry.gopPatternSample || 'Not available'}
                </p>
                <p className="mt-0.5 text-[11px] font-mono tabular-nums text-[#64748B]">
                  {analysis.videoTelemetry.frameDeltaVariance !== undefined &&
                  analysis.videoTelemetry.frameDeltaVariance !== null
                    ? `Delta var ${analysis.videoTelemetry.frameDeltaVariance}`
                    : 'Leading encoded frame cadence'}
                  {analysis.videoTelemetry.adaptiveSamplingApplied ? ' · Adaptive' : ''}
                </p>
              </div>
            </div>
          )}

          {analysis.videoTelemetry?.cameraCharacteristicsDetected &&
            analysis.videoTelemetry.cameraCharacteristicsDetected.length > 0 && (
              <div className="bg-[#F5F7FB] border border-[#E5EAF2] rounded-lg px-4 py-3 text-xs text-[#64748B]">
                <span className="font-semibold text-[#172554]">Camera &amp; encoding context: </span>
                {analysis.videoTelemetry.cameraCharacteristicsDetected.join(' · ')}
              </div>
            )}

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            {analysis.videoFrames.map((frame) => {
              const isSelected = selectedFrame?.frameIndex === frame.frameIndex;
              return (
                <button
                  key={frame.frameIndex}
                  type="button"
                  onClick={() => setSelectedFrame(frame)}
                  className={`text-left rounded-lg border overflow-hidden transition-colors cursor-pointer ${
                    isSelected
                      ? 'border-[#2563EB] ring-2 ring-[#2563EB]/20'
                      : 'border-[#E5EAF2] hover:border-[#94A3B8]'
                  }`}
                >
                  <div className="aspect-video bg-[#0F172A] relative overflow-hidden">
                    <img
                      src={frame.thumbnailUrl}
                      alt={`Frame ${frame.frameIndex} at ${frame.timestampLabel}`}
                      className="w-full h-full object-cover"
                    />
                  </div>
                  <div className="p-2 bg-white">
                    <div className="flex items-center justify-between text-[11px] font-mono tabular-nums">
                      <span className="font-semibold text-[#172554]">{frame.timestampLabel}</span>
                      <span
                        className={
                          frame.suspicious ? 'text-[#D97706] font-semibold' : 'text-[#64748B]'
                        }
                      >
                        {frame.anomalyScore}/100
                      </span>
                    </div>
                    <p className="mt-0.5 text-[10px] text-[#64748B] truncate">
                      {frame.watermarkDetected
                        ? 'Watermark flagged'
                        : frame.sceneChange
                          ? 'Scene transition'
                          : frame.suspicious
                            ? 'Indicator flagged'
                            : 'Sampled frame'}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>

          {selectedFrame && (
            <div className="bg-[#F5F7FB] border border-[#E5EAF2] rounded-lg p-4 grid grid-cols-1 md:grid-cols-12 gap-4 items-center">
              <div className="md:col-span-5">
                <img
                  src={selectedFrame.thumbnailUrl}
                  alt={`Selected frame ${selectedFrame.frameIndex}`}
                  className="w-full rounded-md border border-[#E5EAF2] object-cover"
                />
              </div>
              <div className="md:col-span-7 space-y-2 text-xs">
                <p className="font-semibold text-[#172554] font-mono tabular-nums">
                  Frame #{selectedFrame.frameIndex} · Timestamp {selectedFrame.timestampLabel} ·
                  Frame Anomaly Signal: {selectedFrame.anomalyScore}/100
                  {selectedFrame.interFrameDiff !== null
                    ? ` · Inter-Frame Delta: ${selectedFrame.interFrameDiff}%`
                    : ''}
                  {selectedFrame.histogramSimilarity !== undefined &&
                  selectedFrame.histogramSimilarity !== null
                    ? ` · Hist Sim: ${selectedFrame.histogramSimilarity.toFixed(3)}`
                    : ''}
                </p>
                {selectedFrame.watermarkDetail && (
                  <p className="text-[#D97706] font-medium">
                    Visible watermark observation: {selectedFrame.watermarkDetail}
                  </p>
                )}
                <ul className="space-y-1 text-[#64748B] list-disc pl-4">
                  {selectedFrame.observations.map((obs, idx) => (
                    <li key={idx}>{obs}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </div>
      )}

      {(analysis.mediaType === 'pdf' || analysis.mediaType === 'document') &&
        analysis.documentStats && (
          <div className="tl-glass-panel rounded-2xl p-6 space-y-5">
            <div>
              <h2 className="text-base font-semibold text-[#172554]">
                Document Stylometry &amp; Highlighted Text Segments
              </h2>
              <p className="mt-1 text-xs text-[#64748B]">
                AI-text classifiers have significant limitations and cannot establish authorship
                with certainty. Formal, technical, or edited human prose frequently exhibits regular
                cadence.
              </p>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3.5">
              {[
                ['Words / Sentences', `${analysis.documentStats.wordCount} / ${analysis.documentStats.sentenceCount}`],
                ['Avg Sentence Length', `${analysis.documentStats.avgSentenceLength} words`],
                ['Burstiness (CV)', String(analysis.documentStats.burstinessScore)],
                ['Lexical Diversity (TTR)', String(analysis.documentStats.lexicalDiversity)],
              ].map(([label, val]) => (
                <div key={label} className="bg-[#F5F7FB] border border-[#E5EAF2] rounded-lg p-3">
                  <p className="text-[11px] text-[#64748B]">{label}</p>
                  <p className="mt-1 text-sm font-semibold font-mono tabular-nums text-[#172554]">
                    {val}
                  </p>
                </div>
              ))}
            </div>

            {analysis.documentSegments && analysis.documentSegments.length > 0 && (
              <div className="space-y-3">
                {analysis.documentSegments.map((seg) => (
                  <div
                    key={seg.index}
                    className={`rounded-lg border p-4 text-xs ${
                      seg.indicatorLevel === 'elevated'
                        ? 'bg-[#FFFBEB] border-[#FDE68A]'
                        : seg.indicatorLevel === 'notable'
                          ? 'bg-[#F5F7FB] border-[#CBD5E1]'
                          : 'bg-white border-[#E5EAF2]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2 mb-1.5">
                      <span className="font-mono font-semibold text-[#172554]">
                        Passage {seg.index + 1}
                      </span>
                      <span
                        className={`font-medium ${
                          seg.indicatorLevel === 'elevated'
                            ? 'text-[#D97706]'
                            : seg.indicatorLevel === 'notable'
                              ? 'text-[#2563EB]'
                              : 'text-[#64748B]'
                        }`}
                      >
                        {seg.indicatorLevel === 'elevated'
                          ? 'Elevated formulaic pattern'
                          : seg.indicatorLevel === 'notable'
                            ? 'Notable stylistic note'
                            : 'Neutral / unremarkable'}
                      </span>
                    </div>
                    <p className="text-[#172554] leading-relaxed">{seg.excerpt}</p>
                    <p className="mt-2 pt-2 border-t border-[#E5EAF2]/80 text-[#64748B]">
                      Observation: {seg.reason}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

      {analysis.mediaType === 'audio' && analysis.audioProfile && (
        <div className="tl-glass-panel rounded-2xl p-6 space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-[#172554]">
                Acoustic Waveform &amp; Timestamped Observations
              </h2>
              <p className="mt-0.5 text-xs text-[#64748B]">
                Decoded via FFmpeg 16 kHz mono PCM for deterministic loudness, silence, and DFT
                spectral measurements
              </p>
            </div>
            {analysis.mediaRetained && analysis.previewUrl && (
              <audio ref={audioPlayerRef} src={analysis.previewUrl} controls className="h-9" />
            )}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3.5">
            {[
              [
                'Spectral Centroid',
                analysis.audioProfile.spectralCentroidHz
                  ? `${analysis.audioProfile.spectralCentroidHz} Hz`
                  : 'N/A',
              ],
              ['Silence Ratio', `${(analysis.audioProfile.silenceRatio * 100).toFixed(1)}%`],
              ['Dynamic Range', `${analysis.audioProfile.dynamicRangeDb} dB`],
              ['Clipping Rate', `${(analysis.audioProfile.clippingRate * 100).toFixed(2)}%`],
              [
                'Noise Floor',
                analysis.audioProfile.noiseFloorDb !== undefined
                  ? `${analysis.audioProfile.noiseFloorDb} dB`
                  : 'N/A',
              ],
              [
                'Synthetic Cues Aligned',
                `${analysis.audioProfile.syntheticIndicatorCount ?? 0} indicator${
                  (analysis.audioProfile.syntheticIndicatorCount ?? 0) === 1 ? '' : 's'
                }`,
              ],
            ].map(([label, val]) => (
              <div key={label} className="bg-[#F5F7FB] border border-[#E5EAF2] rounded-lg p-3">
                <p className="text-[11px] text-[#64748B]">{label}</p>
                <p className="mt-1 text-sm font-semibold font-mono tabular-nums text-[#172554]">
                  {val}
                </p>
              </div>
            ))}
          </div>

          <div className="h-[150px] w-full bg-[#F5F7FB] border border-[#E5EAF2] rounded-lg p-3">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={analysis.audioProfile.waveformPeaks.map((peak, idx) => ({
                  bin: idx + 1,
                  amplitude: peak,
                }))}
              >
                <XAxis dataKey="bin" hide />
                <YAxis domain={[0, 1]} hide />
                <Tooltip
                  formatter={(v) => [`${Number(v).toFixed(3)}`, 'Peak Amplitude']}
                  contentStyle={{ fontSize: '11px', borderRadius: '6px' }}
                />
                <Bar dataKey="amplitude" fill="#2563EB" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Multi-Indicator Speech Assessment: Detected Evidence vs Uncertain Signals vs Natural Cues */}
          {(analysis.audioProfile.detectedIndicators?.length ||
            analysis.audioProfile.uncertainSignals?.length ||
            analysis.audioProfile.naturalCues?.length) && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="rounded-xl bg-[#FEF2F2]/70 border border-[#FECACA] p-4">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-xs font-semibold text-[#B91C1C]">
                    Detected Synthetic Speech Evidence
                  </h3>
                  <span className="text-[11px] font-mono text-[#991B1B]">
                    {analysis.audioProfile.detectedIndicators?.length ?? 0}
                  </span>
                </div>
                <ul className="mt-2.5 space-y-1.5 text-xs text-[#7F1D1D]/90 list-disc pl-4 leading-relaxed">
                  {analysis.audioProfile.detectedIndicators &&
                  analysis.audioProfile.detectedIndicators.length > 0 ? (
                    analysis.audioProfile.detectedIndicators.map((item, idx) => (
                      <li key={idx}>{item}</li>
                    ))
                  ) : (
                    <li className="text-[#64748B]">
                      No corroborated multi-indicator synthetic speech evidence detected.
                    </li>
                  )}
                </ul>
              </div>

              <div className="rounded-xl bg-[#FFFBEB]/80 border border-[#FDE68A] p-4">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-xs font-semibold text-[#92400E]">
                    Uncertain Signals (Not Standalone Proof)
                  </h3>
                  <span className="text-[11px] font-mono text-[#92400E]">
                    {analysis.audioProfile.uncertainSignals?.length ?? 0}
                  </span>
                </div>
                <ul className="mt-2.5 space-y-1.5 text-xs text-[#92400E]/90 list-disc pl-4 leading-relaxed">
                  {analysis.audioProfile.uncertainSignals &&
                  analysis.audioProfile.uncertainSignals.length > 0 ? (
                    analysis.audioProfile.uncertainSignals.map((item, idx) => (
                      <li key={idx}>{item}</li>
                    ))
                  ) : (
                    <li className="text-[#64748B]">No isolated or ambiguous audio cues recorded.</li>
                  )}
                </ul>
              </div>

              <div className="rounded-xl bg-[#F0FDF4]/80 border border-[#BBF7D0] p-4">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-xs font-semibold text-[#15803D]">
                    Natural Human Audio Cues
                  </h3>
                  <span className="text-[11px] font-mono text-[#166534]">
                    {analysis.audioProfile.naturalCues?.length ?? 0}
                  </span>
                </div>
                <ul className="mt-2.5 space-y-1.5 text-xs text-[#166534]/90 list-disc pl-4 leading-relaxed">
                  {analysis.audioProfile.naturalCues &&
                  analysis.audioProfile.naturalCues.length > 0 ? (
                    analysis.audioProfile.naturalCues.map((item, idx) => <li key={idx}>{item}</li>)
                  ) : (
                    <li className="text-[#64748B]">No explicit natural speech cues logged.</li>
                  )}
                </ul>
              </div>
            </div>
          )}

          {analysis.audioProfile.segments.length > 0 && (
            <div className="divide-y divide-[#E5EAF2] border border-[#E5EAF2] rounded-lg">
              {analysis.audioProfile.segments.map((seg, i) => {
                const isClickable = Boolean(analysis.mediaRetained && analysis.previewUrl);
                const isActive = activeAudioSec === seg.startSec;
                return (
                  <button
                    key={i}
                    type="button"
                    disabled={!isClickable}
                    onClick={() => seekAudioSegment(seg.startSec)}
                    className={`w-full text-left px-4 py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs transition-colors ${
                      isClickable ? 'hover:bg-[#F5F7FB] cursor-pointer' : ''
                    } ${isActive ? 'bg-[#2563EB]/5' : ''}`}
                  >
                    <div className="flex items-center gap-3">
                      <span className="inline-flex items-center gap-1.5 font-mono tabular-nums font-semibold text-[#2563EB]">
                        {isClickable && <Play className="w-3 h-3 fill-current" />}
                        {seg.timestampLabel}
                      </span>
                      <span className="text-[#64748B]">{seg.observation}</span>
                    </div>
                    {seg.rmsDb !== 0 && (
                      <span className="font-mono tabular-nums text-[#64748B] whitespace-nowrap">
                        RMS {seg.rmsDb} dB · ZCR {seg.zeroCrossingRate}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Clear Separation: Observed Technical Evidence vs AI-Generated Explanation */}
      {analysis.geminiSummary && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          <div className="lg:col-span-6 tl-glass-panel rounded-2xl p-6">
            <p className="text-xs font-medium text-[#2563EB]">Deterministic &amp; Detector Outputs</p>
            <h2 className="mt-1 text-base font-semibold text-[#172554]">
              Observed Technical Evidence
            </h2>
            <ul className="mt-4 space-y-2.5 text-xs leading-relaxed text-[#64748B]">
              {analysis.geminiSummary.observedEvidence.map((item, i) => (
                <li key={i} className="pb-2.5 border-b border-[#E5EAF2] last:border-b-0 last:pb-0">
                  {item}
                </li>
              ))}
            </ul>
          </div>

          <div className="lg:col-span-6 tl-glass-panel rounded-2xl p-6 space-y-4">
            <div>
              <p className="text-xs font-medium text-[#64748B]">
                AI-Generated Interpretation ({analysis.geminiSummary.modelUsed})
              </p>
              <h2 className="mt-1 text-base font-semibold text-[#172554]">
                Executive Summary &amp; Reasoning
              </h2>
              <p className="mt-2.5 text-sm leading-relaxed text-[#172554]">
                {analysis.geminiSummary.executiveSummary}
              </p>
              <p className="mt-2 text-xs leading-relaxed text-[#64748B]">
                {analysis.geminiSummary.aiExplanation}
              </p>
            </div>

            {analysis.geminiSummary.suspiciousIndicators.length > 0 && (
              <div className="pt-3 border-t border-[#E5EAF2]">
                <h3 className="text-xs font-semibold text-[#172554] mb-1.5">
                  Notable Indicators Identified
                </h3>
                <ul className="space-y-1 text-xs text-[#64748B] list-disc pl-4">
                  {analysis.geminiSummary.suspiciousIndicators.map((ind, idx) => (
                    <li key={idx}>{ind}</li>
                  ))}
                </ul>
              </div>
            )}

            {analysis.geminiSummary.technicalObservations.length > 0 && (
              <div className="pt-3 border-t border-[#E5EAF2]">
                <h3 className="text-xs font-semibold text-[#172554] mb-1.5">
                  Technical Observations
                </h3>
                <ul className="space-y-1 text-xs text-[#64748B] list-disc pl-4">
                  {analysis.geminiSummary.technicalObservations.map((obs, idx) => (
                    <li key={idx}>{obs}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}

      {/* HIGH PRIORITY: Watermark & Provenance Findings */}
      <div className="tl-glass-panel rounded-2xl overflow-hidden">
        <div className="px-6 py-4 border-b border-[#E5EAF2] flex items-center gap-2.5">
          <ScanEye className="w-4 h-4 text-[#2563EB]" />
          <div>
            <h2 className="text-base font-semibold text-[#172554]">
              Watermark &amp; Provenance Verification
            </h2>
            <p className="text-xs text-[#64748B]">
              Visible OCR/logo scanning, imperceptible watermark status, and C2PA container
              provenance are tracked independently.
            </p>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-[#E5EAF2] bg-[#F5F7FB]/60 text-[#64748B] font-medium">
                <th className="py-3 px-6">Capability</th>
                <th className="py-3 px-4">Status / Recognition</th>
                <th className="py-3 px-4">Position &amp; Timestamp</th>
                <th className="py-3 px-4">Confidence</th>
                <th className="py-3 px-6">Platform Association &amp; Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E5EAF2]">
              {analysis.watermarks.map((wm) => (
                <tr key={wm.id}>
                  <td className="py-3.5 px-6 font-medium text-[#172554] whitespace-nowrap">
                    {wm.detectionMethod}
                  </td>
                  <td className="py-3.5 px-4">
                    <span
                      className={`font-semibold ${
                        wm.detected ? 'text-[#D97706]' : 'text-[#64748B]'
                      }`}
                    >
                      {wm.detected
                        ? wm.recognizedTextOrLogo || 'Detected'
                        : wm.type === 'invisible_watermark'
                          ? 'Not performed'
                          : 'Not detected'}
                    </span>
                  </td>
                  <td className="py-3.5 px-4 font-mono tabular-nums text-[#64748B]">
                    {wm.positionInFrame || '--'}
                    {wm.timestamp ? ` · ${wm.timestamp}` : ''}
                    {wm.persistenceSummary ? (
                      <div className="font-sans text-[11px] mt-0.5">{wm.persistenceSummary}</div>
                    ) : null}
                  </td>
                  <td className="py-3.5 px-4 text-[#172554] whitespace-nowrap">
                    {wm.recognitionConfidence}
                  </td>
                  <td className="py-3.5 px-6 text-[#64748B]">
                    <div className="flex flex-col sm:flex-row sm:items-start gap-3">
                      <div className="flex-1 min-w-0">
                        {wm.possiblePlatform && (
                          <span className="font-medium text-[#172554] block mb-0.5">
                            Possible platform: {wm.possiblePlatform}
                          </span>
                        )}
                        {wm.note}
                      </div>
                      {wm.cropImageUrl && (
                        <div className="shrink-0">
                          <img
                            src={wm.cropImageUrl}
                            alt={`Cropped watermark evidence for ${wm.recognizedTextOrLogo || wm.detectionMethod}`}
                            className="h-14 max-w-[140px] object-contain rounded border border-[#E5EAF2] bg-[#0F172A]/5"
                          />
                          <p className="mt-0.5 text-[10px] font-mono text-[#64748B]">
                            Evidence crop
                          </p>
                        </div>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Detector-by-Detector Results (Performed vs Failed vs Unavailable) */}
      <div className="tl-glass-panel rounded-2xl overflow-hidden">
        <div className="px-6 py-4 border-b border-[#E5EAF2]">
          <h2 className="text-base font-semibold text-[#172554]">
            Detector-by-Detector Results ({performedDetectors.length} completed
            {failedDetectors.length > 0 ? ` · ${failedDetectors.length} failed` : ''} ·{' '}
            {unavailableDetectors.length} unavailable / not applicable)
          </h2>
          <p className="text-xs text-[#64748B] mt-0.5">
            Click any method row to inspect full observed evidence, correlation group, and method
            limitations.
          </p>
        </div>

        <div>{performedDetectors.map(renderDetectorRow)}</div>

        {failedDetectors.length > 0 && (
          <>
            <div className="px-6 py-2.5 bg-[#FEF2F2] border-y border-[#FECACA] text-xs font-semibold text-[#991B1B]">
              Failed Detectors (Recoverable — Excluded from Scoring, Never Treated as AI Evidence)
            </div>
            <div>{failedDetectors.map(renderDetectorRow)}</div>
          </>
        )}

        {unavailableDetectors.length > 0 && (
          <>
            <div className="px-6 py-2.5 bg-[#F5F7FB] border-y border-[#E5EAF2] text-xs font-semibold text-[#64748B]">
              Unavailable or Non-Applicable Methods (Explicitly Disclosed)
            </div>
            <div>{unavailableDetectors.map(renderDetectorRow)}</div>
          </>
        )}
      </div>

      {/* Scoring Engine Transparency */}
      {scoring && (
        <div className="tl-glass-panel rounded-2xl p-6 space-y-4">
          <h2 className="text-base font-semibold text-[#172554]">
            How This Score Was Produced
          </h2>
          <ul className="space-y-1.5 text-xs text-[#64748B] list-disc pl-4">
            {scoring.scoreExplanation.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>

          <div className="overflow-x-auto pt-2">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-[#E5EAF2] text-[#64748B] font-medium">
                  <th className="py-2 pr-4">Detector</th>
                  <th className="py-2 px-3">Correlation Group</th>
                  <th className="py-2 px-3 text-right">Raw Signal</th>
                  <th className="py-2 px-3 text-right">Applied Weight</th>
                  <th className="py-2 pl-3">Aggregation Note</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E5EAF2]">
                {scoring.methodContributions.map((c, idx) => (
                  <tr key={idx}>
                    <td className="py-2.5 pr-4 font-medium text-[#172554]">{c.methodName}</td>
                    <td className="py-2.5 px-3 font-mono text-[#64748B]">{c.correlationGroup}</td>
                    <td className="py-2.5 px-3 text-right font-mono tabular-nums text-[#172554]">
                      {c.rawScore !== null ? `${c.rawScore}/100` : '--'}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono tabular-nums text-[#64748B]">
                      {c.weightApplied > 0 ? c.weightApplied.toFixed(2) : '0.00'}
                    </td>
                    <td className="py-2.5 pl-3 text-[#64748B]">{c.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Extracted Metadata Table */}
      <div className="tl-glass-panel rounded-2xl overflow-hidden">
        <div className="px-6 py-4 border-b border-[#E5EAF2]">
          <h2 className="text-base font-semibold text-[#172554]">Extracted File Metadata</h2>
          <p className="text-xs text-[#64748B] mt-0.5">
            Metadata can be edited, stripped, or forged. Missing metadata never implies AI
            generation, and software tags alone do not prove AI synthesis.
          </p>
        </div>
        <div className="divide-y divide-[#E5EAF2]">
          {metadataRows.map(([k, v]) => (
            <div
              key={k}
              className="px-6 py-2.5 grid grid-cols-1 sm:grid-cols-12 gap-2 text-xs"
            >
              <span className="sm:col-span-4 font-medium text-[#64748B]">{k}</span>
              <span className="sm:col-span-8 font-mono break-all text-[#172554]">{v}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Limitations & Next Steps */}
      {analysis.geminiSummary && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div className="tl-glass-panel rounded-2xl p-6">
            <h2 className="text-sm font-semibold text-[#172554]">Confidence Limitations</h2>
            <ul className="mt-3 space-y-2 text-xs leading-relaxed text-[#64748B] list-disc pl-4">
              {analysis.geminiSummary.confidenceLimitations.map((lim, i) => (
                <li key={i}>{lim}</li>
              ))}
            </ul>
          </div>
          <div className="tl-glass-panel rounded-2xl p-6">
            <h2 className="text-sm font-semibold text-[#172554]">Recommended Next Steps</h2>
            <ul className="mt-3 space-y-2 text-xs leading-relaxed text-[#64748B] list-disc pl-4">
              {analysis.geminiSummary.recommendedNextSteps.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
