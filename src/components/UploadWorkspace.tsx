import { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  AudioWaveform,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  FileSearch,
  FileText,
  Film,
  Image as ImageIcon,
  RefreshCw,
  RotateCcw,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { ApiRequestError, uploadSingleFileWithProgress } from '../lib/api';
import { formatBytes, mediaTypeLabel } from '../lib/formatters';
import type { AnalysisRecord, MediaType } from '../types/forensics';
import { PremiumButton } from './PremiumUi';

interface UploadWorkspaceProps {
  maxUploadSizeMb: number;
  onAnalysesStarted: (analyses: AnalysisRecord[]) => void;
  onRunSample: (sampleType: 'image' | 'document') => void;
  runningSample: boolean;
}

type UploadStage =
  | 'idle'
  | 'selected'
  | 'validating'
  | 'uploading'
  | 'completed'
  | 'failed'
  | 'cancelled';

type PerFileStatus = 'queued' | 'uploading' | 'uploaded' | 'failed' | 'cancelled';

interface QueuedFile {
  id: string;
  file: File;
  mediaType: MediaType;
  previewUrl?: string;
  magicSignatureNote: string;
  status: PerFileStatus;
  progress: number;
  loadedBytes: number;
  error?: string;
  errorDetails?: string;
  analysis?: AnalysisRecord;
}

interface UploadErrorState {
  category:
    | 'Unsupported format'
    | 'Exceeds size limit'
    | 'Upload interrupted'
    | 'Corrupted or invalid file'
    | 'Validation error'
    | 'Server routing error';
  message: string;
  details?: string;
  retryable: boolean;
  suggestRefresh?: boolean;
}

const SUPPORTED_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.mp4',
  '.mov',
  '.webm',
  '.pdf',
  '.docx',
  '.txt',
  '.wav',
  '.mp3',
  '.m4a',
]);

function detectClientMediaType(file: File): MediaType | null {
  const ext = `.${file.name.split('.').pop()?.toLowerCase() ?? ''}`;
  if (!SUPPORTED_EXTENSIONS.has(ext)) return null;
  if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) return 'image';
  if (['.mp4', '.mov', '.webm'].includes(ext)) return 'video';
  if (['.wav', '.mp3', '.m4a'].includes(ext)) return 'audio';
  if (ext === '.pdf') return 'pdf';
  return 'document';
}

async function inspectClientHeaderSignature(
  file: File,
  expectedType: MediaType,
): Promise<{ ok: boolean; note: string; error?: string }> {
  try {
    const slice = await file.slice(0, 16).arrayBuffer();
    const bytes = new Uint8Array(slice);
    if (bytes.length === 0) {
      return { ok: false, note: 'Empty file', error: `"${file.name}" contains 0 bytes.` };
    }

    const startsWith = (sig: number[]) => sig.every((b, idx) => bytes[idx] === b);
    const ascii = String.fromCharCode(...bytes);

    if (expectedType === 'image') {
      if (startsWith([0xff, 0xd8, 0xff])) return { ok: true, note: 'JPEG magic verified (FF D8 FF)' };
      if (startsWith([0x89, 0x50, 0x4e, 0x47])) return { ok: true, note: 'PNG magic verified (89 50 4E 47)' };
      if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') {
        return { ok: true, note: 'WEBP RIFF magic verified' };
      }
      return {
        ok: false,
        note: 'Header mismatch',
        error: `"${file.name}" does not match a valid JPEG, PNG, or WEBP binary signature (extension alone is not trusted).`,
      };
    }

    if (expectedType === 'pdf') {
      if (ascii.startsWith('%PDF-')) return { ok: true, note: 'PDF header verified (%PDF-)' };
      return {
        ok: false,
        note: 'Header mismatch',
        error: `"${file.name}" lacks a valid %PDF- binary header and may be corrupted or mislabeled.`,
      };
    }

    if (expectedType === 'video') {
      if (ascii.slice(4, 8) === 'ftyp') return { ok: true, note: 'ISO BMFF / MP4 / MOV header verified' };
      if (startsWith([0x1a, 0x45, 0xdf, 0xa3])) return { ok: true, note: 'WebM / EBML header verified' };
      return {
        ok: false,
        note: 'Header mismatch',
        error: `"${file.name}" does not have a recognized MP4, MOV, or WebM container signature.`,
      };
    }

    if (expectedType === 'audio') {
      if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WAVE') {
        return { ok: true, note: 'WAV RIFF header verified' };
      }
      if (ascii.startsWith('ID3') || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) {
        return { ok: true, note: 'MP3 audio header verified' };
      }
      if (ascii.slice(4, 8) === 'ftyp') {
        return { ok: true, note: 'M4A / MP4 audio header verified' };
      }
      return { ok: true, note: 'Deferred to server FFprobe & magic check' };
    }

    const ext = `.${file.name.split('.').pop()?.toLowerCase() ?? ''}`;
    if (ext === '.docx') {
      if (startsWith([0x50, 0x4b, 0x03, 0x04])) return { ok: true, note: 'DOCX ZIP container verified' };
      return {
        ok: false,
        note: 'Header mismatch',
        error: `"${file.name}" is not a valid DOCX archive (missing PK zip header).`,
      };
    }

    const hasNullByte = bytes.some((b) => b === 0x00);
    if (hasNullByte) {
      return {
        ok: false,
        note: 'Binary content in .txt',
        error: `"${file.name}" contains binary null bytes and does not appear to be plain UTF-8 text.`,
      };
    }
    return { ok: true, note: 'Plain UTF-8 text header checked' };
  } catch {
    return { ok: true, note: 'Server magic-byte verification pending' };
  }
}

function plannedMethodsForType(type: MediaType): string[] {
  switch (type) {
    case 'image':
      return [
        'Pixel entropy, Laplacian & noise residual (sharp)',
        'Error Level Analysis (ELA Q90 + Q90/Q75 double-JPEG delta)',
        'Visible watermark OCR + zoomed edge/corner strips',
        'EXIF / XMP / ICC & C2PA manifest scan',
        'PRNU & Copy-Move explicitly disclosed as unavailable',
      ];
    case 'video':
      return [
        'FFprobe stream/codec & GOP I/P/B structure inspection',
        'FFmpeg multi-frame sampling with full frame count disclosure',
        'Bhattacharyya histogram similarity & inter-frame delta',
        'Cross-frame visible watermark tracking + cropped evidence capture',
        'Temporal, lighting & facial consistency review',
      ];
    case 'audio':
      return [
        '16 kHz PCM waveform & DFT spectral centroid',
        'Dynamic range, silence ratio & clipping analysis',
        'Multimodal speech, prosody & vocoder artifact review',
        'Audio container & encoder metadata inspection',
      ];
    case 'pdf':
      return [
        'PDF text layer extraction & structural inspection',
        'Font & embedded Image XObject inventory',
        'Stylometry, sentence burstiness & 4-gram repetition',
        'Cautious linguistic pattern assessment',
      ];
    case 'document':
      return [
        'DOCX / UTF-8 text extraction & structural check',
        'Sentence-length variance & lexical diversity',
        'Repetitive pattern & passage-level inspection',
        'Cautious linguistic assessment (limitations disclosed)',
      ];
  }
}

function mapApiErrorToUploadError(err: unknown): UploadErrorState {
  if (err instanceof ApiRequestError) {
    if (err.code === 'NON_JSON_RESPONSE' || err.status === 404) {
      return {
        category: 'Server routing error',
        message: err.message,
        details: err.details,
        retryable: true,
        suggestRefresh: true,
      };
    }
    if (err.status === 413 || err.message.toLowerCase().includes('exceeds') || err.message.toLowerCase().includes('limit')) {
      return {
        category: 'Exceeds size limit',
        message: err.message,
        details: err.details,
        retryable: false,
      };
    }
    if (err.code === 'CANCELLED' || err.code === 'NETWORK_ERROR' || err.code === 'UPLOAD_TIMEOUT') {
      return {
        category: 'Upload interrupted',
        message: err.message,
        details: err.details,
        retryable: true,
      };
    }
    const lower = err.message.toLowerCase();
    if (lower.includes('unsupported') || lower.includes('format') || lower.includes('mime')) {
      return {
        category: 'Unsupported format',
        message: err.message,
        details: err.details,
        retryable: false,
      };
    }
    if (lower.includes('corrupt') || lower.includes('bomb') || lower.includes('invalid')) {
      return {
        category: 'Corrupted or invalid file',
        message: err.message,
        details: err.details,
        retryable: false,
      };
    }
    return {
      category: 'Validation error',
      message: err.message,
      details: err.details,
      retryable: err.retryable,
      suggestRefresh: err.suggestRefresh,
    };
  }
  return {
    category: 'Upload interrupted',
    message: err instanceof Error ? err.message : 'Unexpected upload failure.',
    retryable: true,
  };
}

export function UploadWorkspace({
  maxUploadSizeMb,
  onAnalysesStarted,
  onRunSample,
  runningSample,
}: UploadWorkspaceProps) {
  const [queue, setQueue] = useState<QueuedFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [uploadStage, setUploadStage] = useState<UploadStage>('idle');
  const [uploadError, setUploadError] = useState<UploadErrorState | null>(null);
  const [showErrorDetails, setShowErrorDetails] = useState(false);
  const [completedInBatch, setCompletedInBatch] = useState<AnalysisRecord[]>([]);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const submittingRef = useRef(false);
  const previewUrlsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const urls = previewUrlsRef.current;
    return () => {
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      for (const url of urls) {
        URL.revokeObjectURL(url);
      }
      urls.clear();
    };
  }, []);

  const isUploading = uploadStage === 'uploading';
  const isValidating = uploadStage === 'validating';

  const aggregateProgress =
    queue.length === 0
      ? 0
      : Math.round(queue.reduce((sum, item) => sum + item.progress, 0) / queue.length);

  const addFiles = async (incoming: FileList | File[]) => {
    if (submittingRef.current) return;
    setUploadError(null);
    setShowErrorDetails(false);
    setUploadStage('validating');

    const maxBytes = maxUploadSizeMb * 1024 * 1024;
    const accepted: QueuedFile[] = [];
    let firstError: UploadErrorState | null = null;

    // Snapshot existing signatures to avoid accidentally adding the exact same file twice in one selection
    const existingKeys = new Set(
      queue.map((q) => `${q.file.name}::${q.file.size}::${q.file.lastModified}`),
    );

    for (const file of Array.from(incoming)) {
      if (queue.length + accepted.length >= 6) {
        firstError = firstError ?? {
          category: 'Validation error',
          message: 'Maximum 6 files can be queued in a single upload batch.',
          retryable: false,
        };
        break;
      }

      const fileKey = `${file.name}::${file.size}::${file.lastModified}`;
      if (existingKeys.has(fileKey)) {
        continue;
      }
      existingKeys.add(fileKey);

      const type = detectClientMediaType(file);
      if (!type) {
        firstError = firstError ?? {
          category: 'Unsupported format',
          message: `"${file.name}" is not a supported format. Allowed: JPG, JPEG, PNG, WEBP, MP4, MOV, WEBM, PDF, DOCX, TXT, WAV, MP3, M4A.`,
          retryable: false,
        };
        continue;
      }
      if (file.size === 0) {
        firstError = firstError ?? {
          category: 'Corrupted or invalid file',
          message: `"${file.name}" is empty (0 bytes) and cannot be analysed.`,
          retryable: false,
        };
        continue;
      }
      if (file.size > maxBytes) {
        firstError = firstError ?? {
          category: 'Exceeds size limit',
          message: `"${file.name}" (${formatBytes(file.size)}) exceeds the ${maxUploadSizeMb} MB upload limit.`,
          retryable: false,
        };
        continue;
      }

      const sig = await inspectClientHeaderSignature(file, type);
      if (!sig.ok) {
        firstError = firstError ?? {
          category: 'Corrupted or invalid file',
          message: sig.error || `"${file.name}" failed binary signature verification.`,
          retryable: false,
        };
        continue;
      }

      const previewUrl = type === 'image' ? URL.createObjectURL(file) : undefined;
      if (previewUrl) previewUrlsRef.current.add(previewUrl);

      accepted.push({
        id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        file,
        mediaType: type,
        previewUrl,
        magicSignatureNote: sig.note,
        status: 'queued',
        progress: 0,
        loadedBytes: 0,
      });
    }

    if (firstError) {
      setUploadError(firstError);
    }

    if (accepted.length > 0) {
      setQueue((prev) => [...prev, ...accepted]);
      setUploadStage('selected');
    } else {
      setUploadStage(queue.length > 0 ? 'selected' : 'idle');
    }
  };

  const removeFile = (id: string) => {
    if (submittingRef.current) return;
    setQueue((prev) => {
      const target = prev.find((f) => f.id === id);
      if (target?.previewUrl) {
        URL.revokeObjectURL(target.previewUrl);
        previewUrlsRef.current.delete(target.previewUrl);
      }
      const next = prev.filter((f) => f.id !== id);
      if (next.length === 0) {
        setUploadStage('idle');
        setUploadError(null);
        setCompletedInBatch([]);
      }
      return next;
    });
  };

  const handleCancelUpload = () => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    submittingRef.current = false;
    setUploadStage('cancelled');
    setQueue((prev) =>
      prev.map((item) =>
        item.status === 'uploading' || item.status === 'queued'
          ? { ...item, status: 'cancelled', progress: 0, loadedBytes: 0 }
          : item,
      ),
    );
    setUploadError({
      category: 'Upload interrupted',
      message: 'Transfer cancelled before completion. Any remaining files stay queued and ready to retry.',
      retryable: true,
    });
  };

  /**
   * Uploads every pending/failed/cancelled file independently using its own isolated FormData request.
   * Guarantees file #1 can never be reused for file #2, keeps every file within serverless payload limits,
   * and allows partial batch recovery if a single file encounters an error.
   */
  const handleUploadAndAnalyse = async () => {
    if (submittingRef.current || queue.length === 0 || isValidating) return;

    const pendingItems = queue.filter((item) => item.status !== 'uploaded');
    if (pendingItems.length === 0) {
      if (completedInBatch.length > 0) {
        onAnalysesStarted(completedInBatch);
      }
      return;
    }

    submittingRef.current = true;
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setUploadError(null);
    setShowErrorDetails(false);
    setUploadStage('uploading');

    const createdAnalyses: AnalysisRecord[] = [...completedInBatch];
    let lastError: UploadErrorState | null = null;
    let wasCancelled = false;

    for (const item of pendingItems) {
      if (controller.signal.aborted) {
        wasCancelled = true;
        break;
      }

      setQueue((prev) =>
        prev.map((q) =>
          q.id === item.id
            ? { ...q, status: 'uploading', progress: 0, loadedBytes: 0, error: undefined, errorDetails: undefined }
            : q,
        ),
      );

      try {
        const result = await uploadSingleFileWithProgress(item.file, {
          signal: controller.signal,
          onProgress: (pct, loaded) => {
            setQueue((prev) =>
              prev.map((q) => (q.id === item.id ? { ...q, progress: pct, loadedBytes: loaded } : q)),
            );
          },
        });

        createdAnalyses.push(result.analysis);
        setCompletedInBatch([...createdAnalyses]);
        setQueue((prev) =>
          prev.map((q) =>
            q.id === item.id
              ? {
                  ...q,
                  status: 'uploaded',
                  progress: 100,
                  loadedBytes: q.file.size,
                  analysis: result.analysis,
                }
              : q,
          ),
        );
      } catch (err) {
        if (err instanceof ApiRequestError && err.code === 'CANCELLED') {
          wasCancelled = true;
          setQueue((prev) =>
            prev.map((q) => (q.id === item.id ? { ...q, status: 'cancelled', progress: 0 } : q)),
          );
          break;
        }

        const mapped = mapApiErrorToUploadError(err);
        lastError = mapped;
        setQueue((prev) =>
          prev.map((q) =>
            q.id === item.id
              ? {
                  ...q,
                  status: 'failed',
                  progress: 0,
                  error: mapped.message,
                  errorDetails: mapped.details,
                }
              : q,
          ),
        );
      }
    }

    abortControllerRef.current = null;
    submittingRef.current = false;

    if (inputRef.current) {
      inputRef.current.value = '';
    }

    if (wasCancelled) {
      setUploadStage('cancelled');
      return;
    }

    if (!lastError && createdAnalyses.length > 0) {
      setUploadStage('completed');
      for (const item of queue) {
        if (item.previewUrl) {
          URL.revokeObjectURL(item.previewUrl);
          previewUrlsRef.current.delete(item.previewUrl);
        }
      }
      setQueue([]);
      setCompletedInBatch([]);
      onAnalysesStarted(createdAnalyses);
      return;
    }

    // Partial or full failure — keep failed files queued with clear retry & allow inspecting succeeded ones
    setUploadStage('failed');
    if (lastError) {
      setUploadError(lastError);
    }
  };

  const uploadSteps: Array<{ key: UploadStage; label: string }> = [
    { key: 'selected', label: '1. Selected' },
    { key: 'validating', label: '2. Validating' },
    { key: 'uploading', label: '3. Uploading' },
    {
      key: 'completed',
      label:
        uploadStage === 'failed'
          ? '4. Failed'
          : uploadStage === 'cancelled'
            ? '4. Cancelled'
            : '4. Handoff to Analysis',
    },
  ];

  const stepRank: Record<UploadStage, number> = {
    idle: -1,
    selected: 0,
    validating: 1,
    uploading: 2,
    completed: 3,
    failed: 3,
    cancelled: 3,
  };
  const currentRank = stepRank[uploadStage];

  return (
    <div className="space-y-7 max-w-[1000px]">
      <div>
        <h1 className="text-2xl font-bold tracking-[-0.02em] text-[#0F172A]">
          New Forensic Analysis
        </h1>
        <p className="mt-1 text-sm text-[#52607A]">
          Upload an image, video, PDF, text document, or audio recording. TruthLens validates
          binary magic signatures before transfer, uploads every file independently, and routes each
          specimen exclusively to its matching forensic pipeline.
        </p>
      </div>

      {/* Drag-and-Drop Zone */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragging(false);
          if (e.dataTransfer.files?.length) void addFiles(e.dataTransfer.files);
        }}
        className={`rounded-2xl border-2 border-dashed p-8 sm:p-10 text-center transition-all duration-300 backdrop-blur-xl ${
          isDragging
            ? 'border-[#7C3AED] bg-gradient-to-br from-[#EFF6FF]/90 to-[#F3F0FF]/90 shadow-[0_18px_40px_-14px_rgba(124,58,237,0.22)]'
            : 'border-[#BFDBFE] bg-white/78 hover:border-[#A78BFA] hover:bg-white/90 shadow-[0_8px_28px_-14px_rgba(37,99,235,0.12)]'
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".jpg,.jpeg,.png,.webp,.mp4,.mov,.webm,.pdf,.docx,.txt,.wav,.mp3,.m4a"
          onChange={(e) => {
            if (e.target.files?.length) {
              const selected = Array.from(e.target.files);
              e.target.value = '';
              void addFiles(selected);
            }
          }}
          className="hidden"
        />

        <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-[#EFF6FF] to-[#F3F0FF] border border-[#DBEAFE] flex items-center justify-center mx-auto mb-4 shadow-xs">
          <Upload className="w-5 h-5 text-[#5B21B6]" />
        </div>

        <p className="text-base font-semibold text-[#0F172A]">
          Drag and drop media files here, or browse from your device
        </p>
        <p className="mt-1.5 text-xs text-[#52607A]">
          Images (JPG, JPEG, PNG, WEBP) · Videos (MP4, MOV, WEBM) · Documents (PDF, DOCX, TXT) ·
          Audio (WAV, MP3, M4A)
        </p>
        <p className="mt-1 text-xs font-mono tabular-nums text-[#64748B]">
          Up to 6 files per batch · Independent per-file transfer · Max {maxUploadSizeMb} MB per
          file · 100 MP bomb guard
        </p>

        <div className="mt-5 flex items-center justify-center gap-3">
          <PremiumButton
            variant="primary"
            size="md"
            disabled={isUploading}
            onClick={() => inputRef.current?.click()}
          >
            Browse files
          </PremiumButton>
        </div>
      </div>

      {/* Categorized Upload / Validation Error Banner with Retry, Refresh & Debug Details */}
      {uploadError && (
        <div
          role="alert"
          className="bg-[#FEF2F2]/95 backdrop-blur-md border border-[#FECACA] rounded-2xl p-4 space-y-3 text-sm text-[#991B1B]"
        >
          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-[#DC2626]" />
              <div>
                <p className="font-semibold text-xs">{uploadError.category}</p>
                <p className="mt-0.5 text-xs leading-relaxed">{uploadError.message}</p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              {uploadError.retryable && queue.some((q) => q.status !== 'uploaded') && (
                <button
                  type="button"
                  onClick={() => void handleUploadAndAnalyse()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#991B1B] bg-white border border-[#FECACA] hover:bg-[#FEF2F2] rounded-lg transition-colors whitespace-nowrap cursor-pointer"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  Retry upload
                </button>
              )}
              {completedInBatch.length > 0 && (
                <button
                  type="button"
                  onClick={() => onAnalysesStarted(completedInBatch)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-[#172554] hover:bg-[#1E3A8A] rounded-lg transition-colors whitespace-nowrap cursor-pointer"
                >
                  Inspect {completedInBatch.length} started
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              )}
              {uploadError.suggestRefresh && (
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#991B1B] bg-white/80 border border-[#FECACA] hover:bg-white rounded-lg transition-colors whitespace-nowrap cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Refresh page
                </button>
              )}
            </div>
          </div>

          {uploadError.details && (
            <div className="pt-2 border-t border-[#FECACA]/70">
              <button
                type="button"
                onClick={() => setShowErrorDetails((v) => !v)}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-[#991B1B]/80 hover:text-[#991B1B] cursor-pointer"
              >
                {showErrorDetails ? (
                  <ChevronUp className="w-3.5 h-3.5" />
                ) : (
                  <ChevronDown className="w-3.5 h-3.5" />
                )}
                Technical details
              </button>
              {showErrorDetails && (
                <p className="mt-1.5 font-mono text-[11px] text-[#7F1D1D] bg-white/70 border border-[#FECACA] rounded-lg px-3 py-2 break-all">
                  {uploadError.details}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Queued Files List + Independent Per-File Progress */}
      {queue.length > 0 && (
        <div className="tl-glass-panel rounded-2xl overflow-hidden">
          <div className="px-6 py-4 border-b border-[#DCE8F8]/80 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold text-[#0F172A]">
                Upload Queue ({queue.length} {queue.length === 1 ? 'file' : 'files'})
              </h2>
              <p className="text-xs text-[#52607A] mt-0.5">
                Each file uploads and runs independently through the 8-stage server forensic pipeline
              </p>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {isUploading ? (
                <button
                  type="button"
                  onClick={handleCancelUpload}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-[#DC2626] bg-[#FEF2F2] hover:bg-[#FEE2E2] border border-[#FECACA] rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                  Cancel upload
                </button>
              ) : (
                <PremiumButton
                  variant="primary"
                  size="md"
                  disabled={isValidating}
                  onClick={() => void handleUploadAndAnalyse()}
                >
                  <span>
                    {uploadStage === 'failed' || uploadStage === 'cancelled'
                      ? 'Retry remaining files'
                      : queue.length > 1
                        ? `Start forensic analysis (${queue.length} files)`
                        : 'Start forensic analysis'}
                  </span>
                  <ArrowRight className="w-3.5 h-3.5 transition-transform duration-200 group-hover:translate-x-0.5" />
                </PremiumButton>
              )}
            </div>
          </div>

          {/* Separated Upload Lifecycle Strip */}
          <div className="px-6 py-3 bg-[#EFF6FF]/50 border-b border-[#DCE8F8]/80 space-y-2.5">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
              <span className="font-semibold text-[#0F172A]">Upload stage:</span>
              {uploadSteps.map((step, idx) => {
                const isActive = idx === currentRank;
                const isDone = idx < currentRank && uploadStage !== 'failed' && uploadStage !== 'cancelled';
                const isTerminalErr =
                  idx === 3 && (uploadStage === 'failed' || uploadStage === 'cancelled');
                return (
                  <span
                    key={step.key}
                    className={`font-mono tabular-nums ${
                      isTerminalErr
                        ? 'text-[#DC2626] font-semibold'
                        : isActive
                          ? 'text-[#5B21B6] font-semibold'
                          : isDone
                            ? 'text-[#16A34A]'
                            : 'text-[#64748B]'
                    }`}
                  >
                    {step.label}
                  </span>
                );
              })}
            </div>

            {isUploading && (
              <div>
                <div className="flex items-center justify-between text-xs text-[#52607A] mb-1.5">
                  <span>
                    Transferring {queue.filter((q) => q.status === 'uploaded').length + 1} of{' '}
                    {queue.length} independently…
                  </span>
                  <span className="font-mono tabular-nums font-semibold text-[#0F172A]">
                    {aggregateProgress}%
                  </span>
                </div>
                <div className="h-1.5 bg-[#DBEAFE] rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-[#2563EB] to-[#7C3AED] transition-all duration-150"
                    style={{ width: `${aggregateProgress}%` }}
                  />
                </div>
              </div>
            )}
          </div>

          <div className="divide-y divide-[#DCE8F8]/70">
            {queue.map((item) => (
              <div key={item.id} className="p-5 flex flex-col sm:flex-row gap-4 justify-between">
                <div className="flex items-start gap-4 min-w-0 flex-1">
                  <div className="w-16 h-16 rounded-xl border border-[#DCE8F8] bg-[#EFF6FF]/60 overflow-hidden shrink-0 flex items-center justify-center">
                    {item.previewUrl ? (
                      <img
                        src={item.previewUrl}
                        alt={item.file.name}
                        className="w-full h-full object-cover"
                      />
                    ) : item.mediaType === 'video' ? (
                      <Film className="w-6 h-6 text-[#172554]" />
                    ) : item.mediaType === 'audio' ? (
                      <AudioWaveform className="w-6 h-6 text-[#16A34A]" />
                    ) : item.mediaType === 'pdf' ? (
                      <FileSearch className="w-6 h-6 text-[#0284C7]" />
                    ) : (
                      <FileText className="w-6 h-6 text-[#64748B]" />
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
                      <p className="text-sm font-semibold text-[#0F172A] truncate">
                        {item.file.name}
                      </p>
                      {item.status === 'uploaded' && (
                        <span className="text-xs font-medium text-[#16A34A]">
                          · Uploaded ({item.analysis?.id})
                        </span>
                      )}
                      {item.status === 'uploading' && (
                        <span className="text-xs font-mono tabular-nums font-medium text-[#5B21B6]">
                          · {item.progress >= 100 ? 'Starting pipeline…' : `${item.progress}%`}
                        </span>
                      )}
                      {item.status === 'failed' && (
                        <span className="text-xs font-medium text-[#DC2626]">· Failed</span>
                      )}
                    </div>

                    <p className="mt-0.5 text-xs text-[#52607A] font-mono tabular-nums">
                      {mediaTypeLabel(item.mediaType)} · {formatBytes(item.file.size)} ·{' '}
                      <span className="text-[#16A34A] inline-flex items-center gap-1">
                        <CheckCircle2 className="w-3 h-3" />
                        {item.magicSignatureNote}
                      </span>
                    </p>

                    {item.status === 'uploading' && (
                      <div className="mt-2 max-w-md">
                        <div className="h-1 bg-[#DBEAFE] rounded-full overflow-hidden">
                          <div
                            className="h-full bg-gradient-to-r from-[#2563EB] to-[#7C3AED] transition-all duration-150"
                            style={{ width: `${item.progress}%` }}
                          />
                        </div>
                      </div>
                    )}

                    {item.error && (
                      <p className="mt-1.5 text-xs text-[#DC2626] leading-relaxed">{item.error}</p>
                    )}

                    <div className="mt-2.5">
                      <p className="text-xs font-medium text-[#0F172A]">
                        Selected pipeline methods:
                      </p>
                      <p className="mt-0.5 text-xs text-[#52607A] leading-relaxed">
                        {plannedMethodsForType(item.mediaType).join(' · ')}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="shrink-0">
                  <button
                    type="button"
                    disabled={isUploading || item.status === 'uploaded'}
                    onClick={() => removeFile(item.id)}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-[#64748B] hover:text-[#DC2626] hover:bg-[#FEF2F2] rounded-lg transition-colors cursor-pointer disabled:opacity-40"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Sample Specimens for Immediate End-to-End Verification */}
      <div className="tl-glass-panel rounded-2xl p-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4">
          <div>
            <h2 className="text-sm font-semibold text-[#0F172A]">
              Test with built-in sample specimens
            </h2>
            <p className="text-xs text-[#52607A] mt-0.5">
              Runs the real server-side extraction, pixel/stylometric forensics, watermark scanner,
              and multimodal reasoning pipeline end to end.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <button
            type="button"
            disabled={runningSample || isUploading}
            onClick={() => onRunSample('image')}
            className="group text-left p-4 rounded-xl border border-[#DCE8F8] bg-white/80 hover:bg-white hover:border-[#A78BFA]/70 hover:-translate-y-0.5 hover:shadow-[0_12px_28px_-12px_rgba(124,58,237,0.18)] transition-all duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] cursor-pointer disabled:opacity-50"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <ImageIcon className="w-4 h-4 text-[#5B21B6]" />
                <span className="text-sm font-semibold text-[#0F172A]">
                  Research Pavilion Specimen (JPEG)
                </span>
              </div>
              <ArrowRight className="w-4 h-4 text-[#64748B] transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-[#5B21B6]" />
            </div>
            <p className="mt-1.5 text-xs text-[#52607A] leading-relaxed">
              Executes the full Image Forensics Pipeline including sharp ELA + Q90/Q75 double-JPEG
              delta, noise residuals, edge-strip watermark OCR, EXIF/C2PA inspection, and multimodal
              visual reasoning.
            </p>
          </button>

          <button
            type="button"
            disabled={runningSample || isUploading}
            onClick={() => onRunSample('document')}
            className="group text-left p-4 rounded-xl border border-[#DCE8F8] bg-white/80 hover:bg-white hover:border-[#A78BFA]/70 hover:-translate-y-0.5 hover:shadow-[0_12px_28px_-12px_rgba(124,58,237,0.18)] transition-all duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] cursor-pointer disabled:opacity-50"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <FileText className="w-4 h-4 text-[#2563EB]" />
                <span className="text-sm font-semibold text-[#0F172A]">
                  Municipal Water Briefing (TXT)
                </span>
              </div>
              <ArrowRight className="w-4 h-4 text-[#64748B] transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-[#5B21B6]" />
            </div>
            <p className="mt-1.5 text-xs text-[#52607A] leading-relaxed">
              Mixed formal and field-note document testing quantitative stylometry, burstiness CV,
              4-gram repetition, passage highlighting, and AI-text limitation disclaimers.
            </p>
          </button>
        </div>
      </div>
    </div>
  );
}
