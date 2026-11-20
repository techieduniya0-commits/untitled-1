import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Circle,
  HelpCircle,
  Loader2,
  MinusCircle,
  RefreshCw,
  RotateCcw,
  XCircle,
} from 'lucide-react';
import { apiRequest, ApiRequestError, type ApiErrorInfo } from '../lib/api';
import { formatBytes, formatDateTime, mediaTypeLabel } from '../lib/formatters';
import type { AnalysisRecord, PipelineStage } from '../types/forensics';
import { FollowUpContextPanel } from './FollowUpContextPanel';
import { PremiumButton } from './PremiumUi';

interface AnalysisWorkspaceProps {
  analysisId: string;
  initialRecord?: AnalysisRecord | null;
  batchRecords?: AnalysisRecord[];
  onSelectAnalysisId?: (id: string) => void;
  onAnalysisUpdated: (record: AnalysisRecord) => void;
  onViewReport: (record: AnalysisRecord) => void;
  onRetryAnalysis: (id: string) => Promise<void>;
  onNewUpload: () => void;
}

function StageStatusIcon({ status }: { status: PipelineStage['status'] }) {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="w-5 h-5 text-[#16A34A] shrink-0" />;
    case 'partially_completed':
    case 'warning':
      return <AlertTriangle className="w-5 h-5 text-[#D97706] shrink-0" />;
    case 'running':
      return <Loader2 className="w-5 h-5 text-[#6D28D9] animate-spin shrink-0" />;
    case 'retrying':
      return <RefreshCw className="w-5 h-5 text-[#D97706] animate-spin shrink-0" />;
    case 'failed':
      return <XCircle className="w-5 h-5 text-[#DC2626] shrink-0" />;
    case 'unavailable':
      return <MinusCircle className="w-5 h-5 text-[#64748B] shrink-0" />;
    default:
      return <Circle className="w-5 h-5 text-[#CBD5E1] shrink-0" />;
  }
}

function stageStatusLabel(status: PipelineStage['status']): string {
  switch (status) {
    case 'completed':
      return 'Completed';
    case 'partially_completed':
      return 'Partially completed';
    case 'warning':
      return 'Completed (unavailable methods disclosed)';
    case 'running':
      return 'Running on server';
    case 'retrying':
      return 'Retrying with backoff';
    case 'failed':
      return 'Failed';
    case 'unavailable':
      return 'Unavailable';
    default:
      return 'Pending';
  }
}

export function AnalysisWorkspace({
  analysisId,
  initialRecord,
  batchRecords = [],
  onSelectAnalysisId,
  onAnalysisUpdated,
  onViewReport,
  onRetryAnalysis,
  onNewUpload,
}: AnalysisWorkspaceProps) {
  const [record, setRecord] = useState<AnalysisRecord | null>(
    initialRecord && initialRecord.id === analysisId ? initialRecord : null,
  );
  const [fetchError, setFetchError] = useState<ApiErrorInfo | null>(null);
  const [showErrorDetails, setShowErrorDetails] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [pollEpoch, setPollEpoch] = useState(0);

  const onAnalysisUpdatedRef = useRef(onAnalysisUpdated);
  onAnalysisUpdatedRef.current = onAnalysisUpdated;

  const initialRecordRef = useRef<AnalysisRecord | null | undefined>(initialRecord);
  initialRecordRef.current = initialRecord;

  // Keep record synchronized when parent passes an updated record for the same ID (e.g. after retry)
  useEffect(() => {
    if (initialRecord && initialRecord.id === analysisId) {
      setRecord((prev) => {
        if (!prev || prev.id !== analysisId) return initialRecord;
        // Prefer whichever has a higher retryCount or transitioned out of processing
        if ((initialRecord.retryCount ?? 0) > (prev.retryCount ?? 0)) {
          return initialRecord;
        }
        return prev;
      });
    }
  }, [analysisId, initialRecord]);

  // Single, abort-safe polling loop for the active analysisId
  useEffect(() => {
    let active = true;
    let timer: number | null = null;
    let notFoundRetries = 0;
    const controller = new AbortController();

    const seeded =
      initialRecordRef.current && initialRecordRef.current.id === analysisId
        ? initialRecordRef.current
        : null;

    setFetchError(null);
    setShowErrorDetails(false);
    setRecord(seeded);

    // If serverless synchronous upload already returned a terminal state, render directly without redundant poll
    if (seeded && seeded.status !== 'processing' && pollEpoch === 0) {
      return () => {
        active = false;
        controller.abort();
      };
    }

    const poll = async () => {
      if (!active) return;
      try {
        const { data } = await apiRequest<{ analysis?: AnalysisRecord }>(
          `/api/analyses/${encodeURIComponent(analysisId)}`,
          { signal: controller.signal, timeoutMs: 20_000 },
        );
        if (!active) return;

        if (!data.analysis) {
          setFetchError({
            status: 200,
            code: 'EMPTY_ANALYSIS',
            endpoint: `/api/analyses/${analysisId}`,
            message: 'Backend returned an empty analysis payload.',
            details: `HTTP 200 without analysis object for ${analysisId}`,
            retryable: true,
          });
          return;
        }

        notFoundRetries = 0;
        setFetchError(null);
        const latest = data.analysis;
        setRecord(latest);
        onAnalysisUpdatedRef.current(latest);

        if (latest.status === 'processing') {
          timer = window.setTimeout(poll, 1100);
        }
      } catch (err) {
        if (!active) return;
        if (err instanceof ApiRequestError && err.code === 'ABORTED') return;

        if (err instanceof ApiRequestError && err.status === 404 && notFoundRetries < 3) {
          notFoundRetries += 1;
          timer = window.setTimeout(poll, 850);
          return;
        }

        const errorInfo: ApiErrorInfo =
          err instanceof ApiRequestError
            ? {
                status: err.status,
                code: err.code,
                endpoint: err.endpoint,
                message: err.message,
                details: err.details,
                retryable: err.retryable,
                suggestRefresh: err.suggestRefresh,
              }
            : {
                status: 0,
                code: 'POLL_ERROR',
                endpoint: `/api/analyses/${analysisId}`,
                message: 'Connection interrupted while checking live analysis progress.',
                details: err instanceof Error ? err.message : String(err),
                retryable: true,
              };

        setFetchError(errorInfo);
        if (errorInfo.retryable && errorInfo.status !== 404) {
          timer = window.setTimeout(poll, 2800);
        }
      }
    };

    void poll();

    return () => {
      active = false;
      controller.abort();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [analysisId, pollEpoch]);

  // Background-poll sibling processing jobs in a multi-file batch so batch pills stay live
  const siblingProcessingIdsKey = batchRecords
    .filter((b) => b.id !== analysisId && b.status === 'processing')
    .map((b) => b.id)
    .sort()
    .join(',');

  useEffect(() => {
    if (!siblingProcessingIdsKey) return;
    let active = true;
    const ids = siblingProcessingIdsKey.split(',').filter(Boolean);
    const controller = new AbortController();

    const timer = window.setInterval(() => {
      for (const id of ids) {
        void apiRequest<{ analysis?: AnalysisRecord }>(
          `/api/analyses/${encodeURIComponent(id)}`,
          { signal: controller.signal, timeoutMs: 15_000 },
        )
          .then(({ data }) => {
            if (active && data.analysis) {
              onAnalysisUpdatedRef.current(data.analysis);
            }
          })
          .catch(() => {
            // Non-blocking sibling poll
          });
      }
    }, 2400);

    return () => {
      active = false;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [siblingProcessingIdsKey]);

  const handleRetryClick = async () => {
    if (!record || retrying) return;
    setRetrying(true);
    try {
      await onRetryAnalysis(record.id);
      setPollEpoch((n) => n + 1);
    } finally {
      setRetrying(false);
    }
  };

  if (fetchError && !record) {
    return (
      <div className="tl-glass-panel border-[#FECACA] rounded-2xl p-8 max-w-2xl space-y-4">
        <div className="flex items-start gap-3">
          <XCircle className="w-5 h-5 text-[#DC2626] mt-0.5 shrink-0" />
          <div className="space-y-1.5 flex-1">
            <h2 className="text-base font-semibold text-[#0F172A]">Unable to load analysis</h2>
            <p className="text-sm text-[#52607A]">{fetchError.message}</p>

            <div className="pt-3 flex flex-wrap items-center gap-2.5">
              <PremiumButton
                variant="primary"
                size="md"
                onClick={() => setPollEpoch((n) => n + 1)}
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Retry</span>
              </PremiumButton>
              <PremiumButton variant="secondary" size="md" onClick={onNewUpload}>
                Return to Upload Workspace
              </PremiumButton>
              {fetchError.suggestRefresh && (
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="px-3 py-2 text-xs font-medium text-[#52607A] hover:text-[#0F172A] cursor-pointer"
                >
                  Refresh page
                </button>
              )}
            </div>

            <div className="pt-2">
              <button
                type="button"
                onClick={() => setShowErrorDetails((v) => !v)}
                className="inline-flex items-center gap-1 text-xs text-[#64748B] hover:text-[#0F172A] cursor-pointer"
              >
                {showErrorDetails ? (
                  <ChevronUp className="w-3.5 h-3.5" />
                ) : (
                  <ChevronDown className="w-3.5 h-3.5" />
                )}
                Technical details
              </button>
              {showErrorDetails && (
                <p className="mt-1.5 font-mono text-[11px] text-[#475569] bg-white/80 border border-[#DCE8F8] rounded-lg px-3 py-2 break-all">
                  {fetchError.details}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!record) {
    return (
      <div className="space-y-4 max-w-[920px]">
        <div className="h-24 tl-glass-panel rounded-2xl animate-pulse" />
        <div className="h-96 tl-glass-panel rounded-2xl animate-pulse" />
      </div>
    );
  }

  const finishedCount = record.stages.filter(
    (s) =>
      s.status === 'completed' ||
      s.status === 'partially_completed' ||
      s.status === 'warning' ||
      s.status === 'unavailable',
  ).length;

  const isReportReady = record.status === 'completed' || record.status === 'partially_completed';
  const canRetry =
    (record.status === 'partially_completed' || record.status === 'failed') &&
    Boolean(record.mediaRetained || record.canRetryGemini);

  return (
    <div className="space-y-6 max-w-[960px]">
      {/* Multi-File Batch Switcher (shown whenever multiple files were uploaded together) */}
      {batchRecords.length > 1 && onSelectAnalysisId && (
        <div className="tl-glass-panel rounded-2xl p-4 space-y-2.5">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="font-semibold text-[#0F172A]">
              Active Batch ({batchRecords.length} files processed independently)
            </span>
            <span className="font-mono tabular-nums text-[#52607A]">
              {batchRecords.filter((b) => b.status === 'completed' || b.status === 'partially_completed').length}{' '}
              of {batchRecords.length} finished
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {batchRecords.map((item) => {
              const selected = item.id === record.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onSelectAnalysisId(item.id)}
                  className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-medium border transition-all duration-200 cursor-pointer max-w-[240px] ${
                    selected
                      ? 'bg-gradient-to-r from-[#EFF6FF] to-[#F3F0FF] border-[#A78BFA] text-[#4C1D95] shadow-xs'
                      : 'bg-white/75 border-[#DCE8F8] text-[#475569] hover:bg-white hover:border-[#BFDBFE]'
                  }`}
                >
                  {item.status === 'processing' ? (
                    <Loader2 className="w-3.5 h-3.5 text-[#6D28D9] animate-spin shrink-0" />
                  ) : item.status === 'completed' ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-[#16A34A] shrink-0" />
                  ) : item.status === 'needs_context' ? (
                    <HelpCircle className="w-3.5 h-3.5 text-[#7C3AED] shrink-0" />
                  ) : item.status === 'partially_completed' ? (
                    <AlertTriangle className="w-3.5 h-3.5 text-[#D97706] shrink-0" />
                  ) : (
                    <XCircle className="w-3.5 h-3.5 text-[#DC2626] shrink-0" />
                  )}
                  <span className="truncate">{item.fileName}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Non-fatal polling warning banner if connection briefly drops */}
      {fetchError && (
        <div
          role="status"
          className="bg-[#FFFBEB]/95 border border-[#FDE68A] rounded-2xl px-4 py-3 flex flex-wrap items-center justify-between gap-3 text-xs text-[#92400E]"
        >
          <span>
            Live status update interrupted ({fetchError.code}): {fetchError.message}
          </span>
          <button
            type="button"
            onClick={() => setPollEpoch((n) => n + 1)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-white border border-[#FCD34D] rounded-lg font-medium hover:bg-[#FEF3C7]/40 cursor-pointer"
          >
            <RefreshCw className="w-3 h-3" />
            Retry now
          </button>
        </div>
      )}

      {/* File Header Card */}
      <div className="tl-glass-panel rounded-2xl p-6 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[#52607A] font-mono tabular-nums">
            <span>{record.id}</span>
            <span aria-hidden="true">·</span>
            <span>{mediaTypeLabel(record.mediaType)}</span>
            <span aria-hidden="true">·</span>
            <span>{formatBytes(record.fileSizeBytes)}</span>
            <span aria-hidden="true">·</span>
            <span>
              {finishedCount} of {record.stages.length} stages finished
            </span>
            {record.retryCount ? (
              <>
                <span aria-hidden="true">·</span>
                <span>Retry #{record.retryCount}</span>
              </>
            ) : null}
          </div>
          <h1 className="mt-1.5 text-xl font-bold text-[#0F172A] truncate">{record.fileName}</h1>
          {record.fileHash && record.fileHash !== 'pending' && (
            <p className="mt-1 text-xs font-mono text-[#64748B] truncate">
              SHA-256: {record.fileHash}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          {canRetry && (
            <PremiumButton
              variant="secondary"
              size="md"
              disabled={retrying}
              onClick={() => void handleRetryClick()}
            >
              <RefreshCw className={`w-3.5 h-3.5 ${retrying ? 'animate-spin' : ''}`} />
              <span>
                {retrying
                  ? 'Restarting…'
                  : record.status === 'partially_completed'
                    ? 'Retry AI Analysis'
                    : 'Retry Analysis'}
              </span>
            </PremiumButton>
          )}
          {isReportReady && (
            <PremiumButton
              variant="primary"
              size="md"
              onClick={() => onViewReport(record)}
            >
              <span>
                {record.status === 'partially_completed'
                  ? 'Open Partial Report'
                  : 'Open Forensic Report'}
              </span>
              <ArrowRight className="w-3.5 h-3.5 transition-transform duration-200 group-hover:translate-x-0.5" />
            </PremiumButton>
          )}
          {record.status === 'needs_context' && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#F3F0FF] border border-[#DDD6FE] text-xs font-semibold text-[#5B21B6]">
              <HelpCircle className="w-3.5 h-3.5" />
              Follow-up context needed
            </span>
          )}
          {record.status === 'failed' && (
            <PremiumButton variant="secondary" size="md" onClick={onNewUpload}>
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Try another file</span>
            </PremiumButton>
          )}
        </div>
      </div>

      {/* Interactive Follow-Up Questions Gate — Prevents Premature Incomplete Reports */}
      {record.status === 'needs_context' && (
        <FollowUpContextPanel
          record={record}
          mode="required"
          onReanalysisComplete={(updated) => {
            setRecord(updated);
            onAnalysisUpdatedRef.current(updated);
            onViewReport(updated);
          }}
        />
      )}

      {/* Partial Completion Banner */}
      {record.status === 'partially_completed' && (
        <div
          role="status"
          className="bg-[#FFFBEB]/95 border border-[#FDE68A] rounded-2xl p-5 flex flex-col sm:flex-row sm:items-start justify-between gap-4"
        >
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-[#D97706] shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="text-sm font-semibold text-[#92400E]">
                Partial Forensic Report Generated — Independent Detectors Preserved
              </p>
              <p className="text-xs leading-relaxed text-[#92400E]/90">
                Multimodal analysis did not complete (
                {record.geminiFailureDetail || 'upstream service temporarily unavailable'}). All
                local deterministic detectors completed and were aggregated without treating the API
                error as evidence of AI generation.
                {record.mediaType === 'video' && record.videoFrames?.length
                  ? ` ${record.videoFrames.length} extracted video frames are cached on disk and will be reused if you retry.`
                  : ''}
              </p>
            </div>
          </div>
          {canRetry && (
            <button
              type="button"
              disabled={retrying}
              onClick={() => void handleRetryClick()}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-[#92400E] bg-white hover:bg-[#FEF3C7]/40 border border-[#FCD34D] rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${retrying ? 'animate-spin' : ''}`} />
              Retry AI Analysis
            </button>
          )}
        </div>
      )}

      {/* Failure Alert */}
      {record.status === 'failed' && (
        <div
          role="alert"
          className="bg-[#FEF2F2]/95 border border-[#FECACA] rounded-2xl p-5 flex items-start gap-3"
        >
          <XCircle className="w-5 h-5 text-[#DC2626] shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="text-sm font-semibold text-[#991B1B]">
              Forensic pipeline halted ({record.errorCode || 'PROCESSING_ERROR'})
            </p>
            <p className="text-xs leading-relaxed text-[#991B1B]/90">
              {record.errorMessage || 'An unexpected error occurred while processing this file.'}
            </p>
          </div>
        </div>
      )}

      {/* 8 Real Backend Pipeline Stages */}
      <div className="tl-glass-panel rounded-2xl overflow-hidden">
        <div className="px-6 py-4 border-b border-[#DCE8F8]/80 flex items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-[#0F172A]">
              Live Backend Processing Stages
            </h2>
            <p className="text-xs text-[#52607A] mt-0.5">
              Reflects actual server execution states — no simulated progress percentages
            </p>
          </div>
          <span className="text-xs font-mono tabular-nums text-[#52607A]">
            {record.status === 'processing'
              ? 'Polling backend…'
              : record.status === 'needs_context'
                ? 'Awaiting follow-up context'
                : record.status === 'completed'
                  ? `Completed ${formatDateTime(record.completedDate)}`
                  : record.status === 'partially_completed'
                    ? `Partial report ${formatDateTime(record.completedDate)}`
                    : 'Stopped'}
          </span>
        </div>

        <ol className="divide-y divide-[#DCE8F8]/70">
          {record.stages.map((stage, idx) => (
            <li
              key={stage.id}
              className={`px-6 py-4 flex items-start justify-between gap-4 transition-colors ${
                stage.status === 'running'
                  ? 'bg-[#EFF6FF]/60'
                  : stage.status === 'retrying'
                    ? 'bg-[#FFFBEB]/70'
                    : ''
              }`}
            >
              <div className="flex items-start gap-3.5 min-w-0">
                <div className="mt-0.5">
                  <StageStatusIcon status={stage.status} />
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
                    <span className="text-xs font-mono tabular-nums text-[#64748B]">
                      {String(idx + 1).padStart(2, '0')}.
                    </span>
                    <span className="text-sm font-semibold text-[#0F172A]">{stage.label}</span>
                    <span className="text-xs text-[#94A3B8]">·</span>
                    <span
                      className={`text-xs font-medium ${
                        stage.status === 'completed'
                          ? 'text-[#16A34A]'
                          : stage.status === 'warning' ||
                              stage.status === 'partially_completed' ||
                              stage.status === 'retrying'
                            ? 'text-[#D97706]'
                            : stage.status === 'running'
                              ? 'text-[#6D28D9]'
                              : stage.status === 'failed'
                                ? 'text-[#DC2626]'
                                : 'text-[#64748B]'
                      }`}
                    >
                      {stageStatusLabel(stage.status)}
                    </span>
                  </div>
                  {stage.detail && (
                    <p className="mt-1 text-xs leading-relaxed text-[#52607A]">{stage.detail}</p>
                  )}
                </div>
              </div>

              <div className="text-right shrink-0 text-xs font-mono tabular-nums text-[#64748B] whitespace-nowrap">
                {stage.completedAt
                  ? new Date(stage.completedAt).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    })
                  : stage.status === 'retrying'
                    ? 'Retrying'
                    : stage.startedAt
                      ? 'In progress'
                      : 'Waiting'}
              </div>
            </li>
          ))}
        </ol>
      </div>

      {/* Completion Preview Bar */}
      {isReportReady && record.scoring && (
        <div className="tl-glass-panel rounded-2xl p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <p className="text-xs text-[#52607A]">
              {record.scoring.calibrationLabel}
              {record.status === 'partially_completed' ? ' · Partial report' : ''}
            </p>
            <p className="mt-1 text-lg font-bold text-[#0F172A] font-mono tabular-nums">
              {record.scoring.aiLikelihoodScore}/100 — {record.scoring.classification}
            </p>
            <p className="mt-0.5 text-xs text-[#52607A]">
              Evidence strength: {record.scoring.evidenceStrength} ·{' '}
              {record.scoring.methodsPerformedCount} completed ·{' '}
              {record.scoring.methodsFailedCount > 0
                ? `${record.scoring.methodsFailedCount} failed (excluded) · `
                : ''}
              {record.scoring.methodsUnavailableCount} unavailable disclosed
            </p>
          </div>
          <PremiumButton
            variant="primary"
            size="md"
            onClick={() => onViewReport(record)}
          >
            <span>
              {record.status === 'partially_completed'
                ? 'Inspect partial forensic report'
                : 'Inspect full forensic report'}
            </span>
            <ArrowRight className="w-4 h-4 transition-transform duration-200 group-hover:translate-x-0.5" />
          </PremiumButton>
        </div>
      )}
    </div>
  );
}
