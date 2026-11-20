import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Plus,
  Trash2,
  Upload,
} from 'lucide-react';
import type {
  BenchmarkEvaluationReport,
  DatasetRecord,
  DatasetSplit,
  DatasetValidationSummary,
  GroundTruthLabel,
} from '../types/forensics';
import { ApiRequestError, apiRequest } from '../lib/api';

const SPLIT_TABS: Array<{ id: 'all' | DatasetSplit; label: string }> = [
  { id: 'all', label: 'All splits' },
  { id: 'train', label: 'Train' },
  { id: 'validation', label: 'Validation' },
  { id: 'test', label: 'Test' },
  { id: 'live_upload', label: 'Live uploads' },
];

const LABELS: GroundTruthLabel[] = [
  'REAL',
  'AI_GENERATED',
  'AI_ASSISTED',
  'MANIPULATED',
  'UNKNOWN',
];

const RECORDING_CONDITIONS = [
  '',
  'Smartphone Human Video',
  'DSLR / Pro Camera Human Video',
  'Mixed / Low Lighting Human Video',
  'Social Media Re-Encoded Human Video',
  'AI-Generated Human Video',
  'AI Face-Swap / Deepfake Video',
  'Social Media Compressed AI Video',
  'Other',
];

function formatPct(val: number | null): string {
  if (val === null || !Number.isFinite(val)) return '--';
  return `${(val * 100).toFixed(1)}%`;
}

export function DatasetManagerView() {
  const [records, setRecords] = useState<DatasetRecord[]>([]);
  const [validation, setValidation] = useState<DatasetValidationSummary | null>(null);
  const [evaluation, setEvaluation] = useState<BenchmarkEvaluationReport | null>(null);
  const [evalThreshold, setEvalThreshold] = useState<number>(60);
  const [loading, setLoading] = useState(true);
  const [splitFilter, setSplitFilter] = useState<'all' | DatasetSplit>('all');
  const [showAddForm, setShowAddForm] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const csvInputRef = useRef<HTMLInputElement | null>(null);

  const [newRec, setNewRec] = useState({
    sample_id: '',
    file_name: '',
    media_type: 'video',
    ground_truth_label: 'REAL' as GroundTruthLabel,
    split: 'test' as DatasetSplit,
    generation_platform: '',
    recording_condition: 'Smartphone Human Video',
    predicted_score: '',
    visible_watermark: false,
    watermark_text: '',
    metadata_present: true,
    license: '',
    consent_status: '',
    file_hash: '',
    notes: '',
  });

  const loadEvaluation = async (threshold = evalThreshold) => {
    try {
      const { data } = await apiRequest<{ evaluation?: BenchmarkEvaluationReport | null }>(
        `/api/datasets/evaluate?threshold=${encodeURIComponent(String(threshold))}`,
      );
      setEvaluation(data.evaluation ?? null);
    } catch {
      // Non-blocking
    }
  };

  const loadDatasets = async (threshold = evalThreshold) => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const [dsRes, evRes] = await Promise.all([
        apiRequest<{ records?: DatasetRecord[]; validation?: DatasetValidationSummary | null }>(
          '/api/datasets',
        ),
        apiRequest<{ evaluation?: BenchmarkEvaluationReport | null }>(
          `/api/datasets/evaluate?threshold=${encodeURIComponent(String(threshold))}`,
        ).catch(() => ({ status: 200, data: { evaluation: null } })),
      ]);
      setRecords(dsRes.data.records ?? []);
      setValidation(dsRes.data.validation ?? null);
      setEvaluation(evRes.data.evaluation ?? null);
    } catch (err) {
      setErrorMessage(
        err instanceof ApiRequestError
          ? err.message
          : 'Failed to load dataset records from server.',
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadDatasets(evalThreshold);
  }, []);

  const handleThresholdChange = (nextThreshold: number) => {
    setEvalThreshold(nextThreshold);
    void loadEvaluation(nextThreshold);
  };

  const handleExportCsv = () => {
    const link = document.createElement('a');
    link.href = '/api/datasets/export';
    link.download = 'truthlens-dataset-schema.csv';
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  const handleImportCsvFile = async (file: File) => {
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      const csvText = await file.text();
      const { data } = await apiRequest<{
        records?: DatasetRecord[];
        validation?: DatasetValidationSummary | null;
        importedCount?: number;
        skippedDuplicateIds?: string[];
        blockedLeakageIds?: string[];
      }>('/api/datasets/import', {
        method: 'POST',
        body: { csv: csvText },
      });
      setRecords(data.records ?? []);
      setValidation(data.validation ?? null);
      const parts = [`Imported ${data.importedCount ?? 0} record(s).`];
      if (data.skippedDuplicateIds?.length) {
        parts.push(`Skipped ${data.skippedDuplicateIds.length} duplicate sample ID(s).`);
      }
      if (data.blockedLeakageIds?.length) {
        parts.push(
          `Blocked ${data.blockedLeakageIds.length} row(s) due to cross-split SHA-256 hash leakage (${data.blockedLeakageIds.slice(0, 4).join(', ')}).`,
        );
      }
      setStatusMessage(parts.join(' '));
      void loadEvaluation(evalThreshold);
    } catch (err) {
      setErrorMessage(
        err instanceof ApiRequestError ? err.message : 'Error reading or uploading CSV file.',
      );
    }
  };

  const handleCreateRecord = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setStatusMessage(null);
    if (!newRec.sample_id.trim() || !newRec.file_name.trim()) {
      setErrorMessage('Sample ID and File Name are required.');
      return;
    }
    const parsedScore =
      newRec.predicted_score.trim() !== '' && Number.isFinite(Number(newRec.predicted_score))
        ? Math.max(0, Math.min(100, Math.round(Number(newRec.predicted_score))))
        : null;
    try {
      const { data } = await apiRequest<{ record: DatasetRecord }>('/api/datasets', {
        method: 'POST',
        body: {
          ...newRec,
          predicted_score: parsedScore,
        },
      });
      setShowAddForm(false);
      setNewRec({
        sample_id: '',
        file_name: '',
        media_type: 'video',
        ground_truth_label: 'REAL',
        split: 'test',
        generation_platform: '',
        recording_condition: 'Smartphone Human Video',
        predicted_score: '',
        visible_watermark: false,
        watermark_text: '',
        metadata_present: true,
        license: '',
        consent_status: '',
        file_hash: '',
        notes: '',
      });
      setStatusMessage(`Saved dataset sample ${data.record.sample_id}.`);
      await loadDatasets(evalThreshold);
    } catch (err) {
      setErrorMessage(
        err instanceof ApiRequestError ? err.message : 'Could not save dataset record.',
      );
    }
  };

  const handleInlineLabelUpdate = async (rec: DatasetRecord, nextLabel: GroundTruthLabel) => {
    setErrorMessage(null);
    try {
      await apiRequest('/api/datasets', {
        method: 'POST',
        body: {
          ...rec,
          ground_truth_label: nextLabel,
          is_illustrative_seed: false,
        },
      });
      await loadDatasets(evalThreshold);
    } catch (err) {
      setErrorMessage(
        err instanceof ApiRequestError ? err.message : 'Failed to update dataset label.',
      );
    }
  };

  const handleDeleteRecord = async (sampleId: string) => {
    setErrorMessage(null);
    try {
      await apiRequest(`/api/datasets/${encodeURIComponent(sampleId)}`, {
        method: 'DELETE',
      });
      await loadDatasets(evalThreshold);
    } catch (err) {
      setErrorMessage(
        err instanceof ApiRequestError ? err.message : 'Failed to delete dataset row.',
      );
    }
  };

  const filtered = records.filter((r) => splitFilter === 'all' || r.split === splitFilter);
  const eligibleTestRecords = records.filter(
    (r) =>
      r.split === 'test' &&
      !r.is_illustrative_seed &&
      (r.ground_truth_label === 'REAL' || r.ground_truth_label === 'AI_GENERATED'),
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-[-0.02em] text-[#172554]">
            Evaluation &amp; Training Dataset Registry
          </h1>
          <p className="mt-1 text-sm text-[#64748B] max-w-2xl">
            Manage structured 33-field CSV metadata separating train, validation, test, and live
            user uploads. Recording metadata here organizes evaluation governance — it does not
            claim to train a new neural model automatically.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <input
            ref={csvInputRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleImportCsvFile(file);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            onClick={() => csvInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-[#172554] bg-white hover:bg-[#F5F7FB] border border-[#E5EAF2] rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Upload className="w-3.5 h-3.5" />
            Import CSV
          </button>
          <button
            type="button"
            onClick={handleExportCsv}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-[#172554] bg-white hover:bg-[#F5F7FB] border border-[#E5EAF2] rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            Export CSV (33 cols)
          </button>
          <button
            type="button"
            onClick={() => setShowAddForm((v) => !v)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-[#2563EB] hover:bg-[#1D4ED8] rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            Add sample
          </button>
        </div>
      </div>

      {/* Illustrative Seed Notice */}
      <div className="bg-[#FFFBEB] border border-[#FDE68A] rounded-xl p-4 text-xs text-[#92400E] flex items-start gap-3">
        <AlertTriangle className="w-4 h-4 text-[#D97706] shrink-0 mt-0.5" />
        <p>
          <strong>Illustrative Seed Notice:</strong> Seed rows marked as illustrative
          (TL-IMG-001, TL-VID-001, TL-IMG-002, TL-VID-002) exist solely to validate the 33-field CSV
          schema. They are not real verified samples and are never used as evidence of detector
          accuracy. Use only lawfully obtained, appropriately licensed, and consented samples.
        </p>
      </div>

      {statusMessage && (
        <div className="bg-[#F0FDF4] border border-[#BBF7D0] rounded-xl px-4 py-3 text-xs text-[#166534] flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-[#16A34A]" />
          {statusMessage}
        </div>
      )}

      {errorMessage && (
        <div className="bg-[#FEF2F2] border border-[#FECACA] rounded-xl px-4 py-3 text-xs text-[#991B1B]">
          {errorMessage}
        </div>
      )}

      {/* Dataset Validation & Split Statistics */}
      {validation && (
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
          <div className="tl-glass-panel rounded-2xl p-4">
            <p className="text-xs text-[#64748B]">Total schema rows</p>
            <p className="mt-1 text-2xl font-bold font-mono tabular-nums text-[#172554]">
              {validation.totalRecords}
            </p>
            <p className="mt-1 text-[11px] text-[#64748B]">
              {validation.illustrativeSeedCount} illustrative seed(s)
            </p>
          </div>
          <div className="tl-glass-panel rounded-2xl p-4">
            <p className="text-xs text-[#64748B]">Train / Val / Test</p>
            <p className="mt-1 text-2xl font-bold font-mono tabular-nums text-[#172554]">
              {validation.splitCounts.train} / {validation.splitCounts.validation} /{' '}
              {validation.splitCounts.test}
            </p>
            <p className="mt-1 text-[11px] text-[#64748B]">
              {validation.splitCounts.live_upload} live upload log(s)
            </p>
          </div>
          <div className="tl-glass-panel rounded-2xl p-4">
            <p className="text-xs text-[#64748B]">Leakage &amp; Duplicates</p>
            <p
              className={`mt-1 text-2xl font-bold font-mono tabular-nums ${
                validation.crossSplitLeakageWarnings.length +
                  validation.duplicateSampleIds.length >
                0
                  ? 'text-[#DC2626]'
                  : 'text-[#16A34A]'
              }`}
            >
              {validation.crossSplitLeakageWarnings.length + validation.duplicateSampleIds.length}
            </p>
            <p className="mt-1 text-[11px] text-[#64748B]">Cross-split or ID collisions</p>
          </div>
          <div className="tl-glass-panel rounded-2xl p-4">
            <p className="text-xs text-[#64748B]">Missing metadata</p>
            <p className="mt-1 text-2xl font-bold font-mono tabular-nums text-[#D97706]">
              {validation.missingMetadataCount}
            </p>
            <p className="mt-1 text-[11px] text-[#64748B]">Rows with metadata_present=false</p>
          </div>
          <div className="tl-glass-panel rounded-2xl p-4">
            <p className="text-xs text-[#64748B]">Consent / License gaps</p>
            <p className="mt-1 text-2xl font-bold font-mono tabular-nums text-[#172554]">
              {validation.missingConsentOrLicenseCount}
            </p>
            <p className="mt-1 text-[11px] text-[#64748B]">Rows missing governance fields</p>
          </div>
        </div>
      )}

      {validation && validation.crossSplitLeakageWarnings.length > 0 && (
        <div className="bg-[#FEF2F2] border border-[#FECACA] rounded-xl p-4 text-xs text-[#991B1B]">
          <p className="font-semibold">Data Leakage Warnings Detected</p>
          <ul className="mt-1 list-disc pl-4 space-y-0.5">
            {validation.crossSplitLeakageWarnings.map((w, idx) => (
              <li key={idx}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Live Benchmark Evaluation & Calibration Card */}
      <div className="tl-glass-panel rounded-2xl p-5 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-[#172554]">
              Detection Validation &amp; Calibration Metrics (Non-Seed Labeled Specimens)
            </h2>
            <p className="text-xs text-[#64748B] mt-0.5">
              Accuracy, Precision, Recall, F1, False-Positive Rate (FPR), False-Negative Rate (FNR),
              and ROC-AUC are computed live strictly from real non-seed labeled records with
              recorded or linked TruthLens predictions. Illustrative seeds are excluded.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-4 shrink-0">
            <label className="flex items-center gap-2 text-xs text-[#64748B]">
              <span>AI threshold:</span>
              <input
                type="range"
                min={45}
                max={80}
                step={1}
                value={evalThreshold}
                onChange={(e) => handleThresholdChange(Number(e.target.value))}
                className="w-24 accent-[#2563EB] cursor-pointer"
              />
              <span className="font-mono tabular-nums font-semibold text-[#172554]">
                {evalThreshold}/100
              </span>
            </label>
            <span className="text-xs font-mono tabular-nums text-[#64748B] whitespace-nowrap">
              {evaluation?.eligibleCount ?? eligibleTestRecords.length} evaluated row(s)
            </span>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
          {[
            {
              label: 'Accuracy',
              value: formatPct(evaluation?.accuracy ?? null),
              sub:
                evaluation && evaluation.eligibleCount > 0
                  ? `${evaluation.confusionMatrix.tp + evaluation.confusionMatrix.tn}/${evaluation.eligibleCount} correct`
                  : 'Awaiting test run',
              tone: 'text-[#172554]',
            },
            {
              label: 'False-Positive Rate',
              value: formatPct(evaluation?.fpr ?? null),
              sub:
                evaluation && evaluation.negativeCount > 0
                  ? `${evaluation.confusionMatrix.fp}/${evaluation.negativeCount} real flagged`
                  : 'Real human FPR',
              tone:
                evaluation?.fpr !== null && evaluation?.fpr !== undefined
                  ? evaluation.fpr <= 0.1
                    ? 'text-[#16A34A]'
                    : 'text-[#DC2626]'
                  : 'text-[#64748B]',
            },
            {
              label: 'False-Negative Rate',
              value: formatPct(evaluation?.fnr ?? null),
              sub:
                evaluation && evaluation.positiveCount > 0
                  ? `${evaluation.confusionMatrix.fn}/${evaluation.positiveCount} AI missed`
                  : 'AI / deepfake FNR',
              tone: 'text-[#172554]',
            },
            {
              label: 'Precision',
              value: formatPct(evaluation?.precision ?? null),
              sub: 'TP / (TP + FP)',
              tone: 'text-[#172554]',
            },
            {
              label: 'Recall',
              value: formatPct(evaluation?.recall ?? null),
              sub: 'TP / (TP + FN)',
              tone: 'text-[#172554]',
            },
            {
              label: 'F1 Score',
              value: formatPct(evaluation?.f1 ?? null),
              sub: 'Harmonic mean',
              tone: 'text-[#172554]',
            },
            {
              label: 'ROC-AUC',
              value:
                evaluation?.rocAuc !== null && evaluation?.rocAuc !== undefined
                  ? evaluation.rocAuc.toFixed(3)
                  : '--',
              sub:
                evaluation?.meanRealScore !== null && evaluation?.meanAiScore !== null
                  ? `Real ${evaluation?.meanRealScore} vs AI ${evaluation?.meanAiScore}`
                  : 'Requires both classes',
              tone: 'text-[#2563EB]',
            },
          ].map((m) => (
            <div key={m.label} className="bg-[#F5F7FB] border border-[#E5EAF2] rounded-lg p-3">
              <p className="text-[11px] text-[#64748B]">{m.label}</p>
              <p
                className={`mt-1 text-base font-bold font-mono tabular-nums ${
                  evaluation && evaluation.eligibleCount > 0 ? m.tone : 'text-[#64748B]'
                }`}
              >
                {m.value}
              </p>
              <p className="mt-0.5 text-[10px] text-[#64748B] truncate">{m.sub}</p>
            </div>
          ))}
        </div>

        {evaluation && evaluation.eligibleCount > 0 && (
          <div className="pt-2 border-t border-[#E5EAF2] space-y-3">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs font-mono tabular-nums text-[#64748B]">
              <span>
                Confusion Matrix · TP:{' '}
                <strong className="text-[#172554]">{evaluation.confusionMatrix.tp}</strong>
              </span>
              <span>
                TN: <strong className="text-[#16A34A]">{evaluation.confusionMatrix.tn}</strong>
              </span>
              <span>
                FP: <strong className="text-[#DC2626]">{evaluation.confusionMatrix.fp}</strong>
              </span>
              <span>
                FN: <strong className="text-[#D97706]">{evaluation.confusionMatrix.fn}</strong>
              </span>
              {evaluation.inconclusiveRate !== null && (
                <span>
                  Inconclusive rate:{' '}
                  <strong className="text-[#172554]">{formatPct(evaluation.inconclusiveRate)}</strong>
                </span>
              )}
            </div>

            {evaluation.byCondition.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-[#E5EAF2] text-[#64748B] font-medium">
                      <th className="py-2 pr-4">Recording / Media Condition</th>
                      <th className="py-2 px-3 text-right">Samples</th>
                      <th className="py-2 px-3 text-right">Mean Score</th>
                      <th className="py-2 px-3 text-right">Accuracy</th>
                      <th className="py-2 px-3 text-right">FPR (Real)</th>
                      <th className="py-2 pl-3 text-right">FNR (AI)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#E5EAF2]">
                    {evaluation.byCondition.map((row) => (
                      <tr key={row.condition}>
                        <td className="py-2 pr-4 font-medium text-[#172554]">{row.condition}</td>
                        <td className="py-2 px-3 text-right font-mono tabular-nums text-[#64748B]">
                          {row.sampleCount} ({row.realCount}R / {row.aiCount}AI)
                        </td>
                        <td className="py-2 px-3 text-right font-mono tabular-nums text-[#172554]">
                          {row.meanScore}/100
                        </td>
                        <td className="py-2 px-3 text-right font-mono tabular-nums text-[#172554]">
                          {formatPct(row.accuracy)}
                        </td>
                        <td className="py-2 px-3 text-right font-mono tabular-nums text-[#64748B]">
                          {formatPct(row.fpr)}
                        </td>
                        <td className="py-2 pl-3 text-right font-mono tabular-nums text-[#64748B]">
                          {formatPct(row.fnr)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {evaluation && evaluation.calibrationNotes.length > 0 && (
          <ul className="text-xs text-[#64748B] list-disc pl-4 space-y-1 pt-1">
            {evaluation.calibrationNotes.map((note, idx) => (
              <li key={idx}>{note}</li>
            ))}
          </ul>
        )}
      </div>

      {/* Add Sample Form */}
      {showAddForm && (
        <form
          onSubmit={handleCreateRecord}
          className="tl-glass-panel rounded-2xl p-6 space-y-4"
        >
          <h2 className="text-sm font-semibold text-[#172554]">Add Labeled Dataset Record</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
            <label className="space-y-1">
              <span className="font-medium text-[#64748B]">Sample ID *</span>
              <input
                required
                value={newRec.sample_id}
                onChange={(e) => setNewRec({ ...newRec, sample_id: e.target.value })}
                placeholder="TL-VID-010"
                className="w-full px-3 py-2 border border-[#E5EAF2] rounded-lg text-[#172554]"
              />
            </label>
            <label className="space-y-1">
              <span className="font-medium text-[#64748B]">File Name *</span>
              <input
                required
                value={newRec.file_name}
                onChange={(e) => setNewRec({ ...newRec, file_name: e.target.value })}
                placeholder="sample_clip.mp4"
                className="w-full px-3 py-2 border border-[#E5EAF2] rounded-lg text-[#172554]"
              />
            </label>
            <label className="space-y-1">
              <span className="font-medium text-[#64748B]">Media Type</span>
              <select
                value={newRec.media_type}
                onChange={(e) => setNewRec({ ...newRec, media_type: e.target.value })}
                className="w-full px-3 py-2 border border-[#E5EAF2] rounded-lg text-[#172554]"
              >
                <option value="image">image</option>
                <option value="video">video</option>
                <option value="pdf">pdf</option>
                <option value="document">document</option>
                <option value="audio">audio</option>
              </select>
            </label>
            <label className="space-y-1">
              <span className="font-medium text-[#64748B]">Ground Truth Label</span>
              <select
                value={newRec.ground_truth_label}
                onChange={(e) =>
                  setNewRec({ ...newRec, ground_truth_label: e.target.value as GroundTruthLabel })
                }
                className="w-full px-3 py-2 border border-[#E5EAF2] rounded-lg text-[#172554]"
              >
                {LABELS.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1">
              <span className="font-medium text-[#64748B]">Dataset Split</span>
              <select
                value={newRec.split}
                onChange={(e) => setNewRec({ ...newRec, split: e.target.value as DatasetSplit })}
                className="w-full px-3 py-2 border border-[#E5EAF2] rounded-lg text-[#172554]"
              >
                <option value="train">train</option>
                <option value="validation">validation</option>
                <option value="test">test</option>
                <option value="live_upload">live_upload</option>
              </select>
            </label>
            <label className="space-y-1">
              <span className="font-medium text-[#64748B]">Generation Platform</span>
              <input
                value={newRec.generation_platform}
                onChange={(e) => setNewRec({ ...newRec, generation_platform: e.target.value })}
                placeholder="None / Unknown / Platform name"
                className="w-full px-3 py-2 border border-[#E5EAF2] rounded-lg text-[#172554]"
              />
            </label>
            <label className="space-y-1">
              <span className="font-medium text-[#64748B]">License</span>
              <input
                value={newRec.license}
                onChange={(e) => setNewRec({ ...newRec, license: e.target.value })}
                placeholder="CC-BY-4.0 / Licensed internal"
                className="w-full px-3 py-2 border border-[#E5EAF2] rounded-lg text-[#172554]"
              />
            </label>
            <label className="space-y-1">
              <span className="font-medium text-[#64748B]">Consent Status</span>
              <input
                value={newRec.consent_status}
                onChange={(e) => setNewRec({ ...newRec, consent_status: e.target.value })}
                placeholder="Verified written consent"
                className="w-full px-3 py-2 border border-[#E5EAF2] rounded-lg text-[#172554]"
              />
            </label>
            <label className="space-y-1">
              <span className="font-medium text-[#64748B]">Recording / Test Condition</span>
              <select
                value={newRec.recording_condition}
                onChange={(e) => setNewRec({ ...newRec, recording_condition: e.target.value })}
                className="w-full px-3 py-2 border border-[#E5EAF2] rounded-lg text-[#172554]"
              >
                {RECORDING_CONDITIONS.map((cond) => (
                  <option key={cond || 'none'} value={cond}>
                    {cond || 'Unspecified'}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1">
              <span className="font-medium text-[#64748B]">Recorded TruthLens Score (0–100)</span>
              <input
                type="number"
                min={0}
                max={100}
                value={newRec.predicted_score}
                onChange={(e) => setNewRec({ ...newRec, predicted_score: e.target.value })}
                placeholder="Optional (auto-links via SHA-256)"
                className="w-full px-3 py-2 font-mono border border-[#E5EAF2] rounded-lg text-[#172554]"
              />
            </label>
            <label className="space-y-1">
              <span className="font-medium text-[#64748B]">Watermark Text (if visible)</span>
              <input
                value={newRec.watermark_text}
                onChange={(e) =>
                  setNewRec({
                    ...newRec,
                    watermark_text: e.target.value,
                    visible_watermark: e.target.value.trim().length > 0,
                  })
                }
                placeholder="Leave blank if none"
                className="w-full px-3 py-2 border border-[#E5EAF2] rounded-lg text-[#172554]"
              />
            </label>
            <label className="space-y-1 sm:col-span-3">
              <span className="font-medium text-[#64748B]">
                SHA-256 File Hash (optional — enforces cross-split leakage blocking &amp; auto-links live analyses)
              </span>
              <input
                value={newRec.file_hash}
                onChange={(e) => setNewRec({ ...newRec, file_hash: e.target.value })}
                placeholder="64-character lowercase hex digest"
                className="w-full px-3 py-2 font-mono border border-[#E5EAF2] rounded-lg text-[#172554]"
              />
            </label>
          </div>
          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setShowAddForm(false)}
              className="px-3.5 py-2 text-xs font-medium text-[#64748B] hover:text-[#172554] cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 text-xs font-medium text-white bg-[#2563EB] hover:bg-[#1D4ED8] rounded-lg cursor-pointer"
            >
              Save record
            </button>
          </div>
        </form>
      )}

      {/* Split Filter Tabs + Table */}
      <div className="tl-glass-panel rounded-2xl overflow-hidden">
        <div className="px-6 py-3.5 border-b border-[#E5EAF2] flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-1 p-1 bg-[#F5F7FB] border border-[#E5EAF2] rounded-lg">
            {SPLIT_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setSplitFilter(tab.id)}
                className={`px-3 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  splitFilter === tab.id
                    ? 'bg-white text-[#172554] shadow-sm'
                    : 'text-[#64748B] hover:text-[#172554]'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <span className="text-xs font-mono tabular-nums text-[#64748B]">
            Showing {filtered.length} of {records.length} record(s)
          </span>
        </div>

        {loading ? (
          <div className="p-6 space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-11 bg-[#F5F7FB] rounded-lg animate-pulse" />
            ))}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-[#E5EAF2] bg-[#F5F7FB]/60 text-[#64748B] font-medium">
                  <th className="py-3 px-6">Sample ID &amp; File</th>
                  <th className="py-3 px-3">Media</th>
                  <th className="py-3 px-3">Ground Truth</th>
                  <th className="py-3 px-3">Split</th>
                  <th className="py-3 px-3">Pred. Score</th>
                  <th className="py-3 px-3">Condition / Platform</th>
                  <th className="py-3 px-6 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E5EAF2]">
                {filtered.map((rec) => (
                  <tr key={rec.sample_id} className="hover:bg-[#F5F7FB]/60">
                    <td className="py-3 px-6">
                      <p className="font-mono font-semibold text-[#172554]">
                        {rec.sample_id}
                        {rec.is_illustrative_seed ? (
                          <span className="ml-2 font-sans font-normal text-[11px] text-[#D97706]">
                            · Illustrative seed
                          </span>
                        ) : null}
                      </p>
                      <p className="text-[#64748B] truncate max-w-[220px]">{rec.file_name}</p>
                    </td>
                    <td className="py-3 px-3 text-[#64748B]">{rec.media_type}</td>
                    <td className="py-3 px-3">
                      {rec.is_illustrative_seed ? (
                        <span className="font-mono font-semibold text-[#172554]">
                          {rec.ground_truth_label}
                        </span>
                      ) : (
                        <select
                          aria-label={`Ground truth label for ${rec.sample_id}`}
                          value={rec.ground_truth_label}
                          onChange={(e) =>
                            void handleInlineLabelUpdate(rec, e.target.value as GroundTruthLabel)
                          }
                          className="px-2 py-1 font-mono text-xs font-semibold text-[#172554] bg-white border border-[#E5EAF2] rounded-md cursor-pointer"
                        >
                          {LABELS.map((l) => (
                            <option key={l} value={l}>
                              {l}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td className="py-3 px-3 font-mono text-[#64748B]">{rec.split}</td>
                    <td className="py-3 px-3 font-mono tabular-nums text-[#172554]">
                      {typeof rec.predicted_score === 'number' ? `${rec.predicted_score}/100` : '--'}
                    </td>
                    <td className="py-3 px-3 text-[#64748B]">
                      {rec.recording_condition ||
                        (rec.generation_platform && rec.generation_platform !== 'None'
                          ? rec.generation_platform
                          : [rec.camera_make, rec.camera_model].filter(Boolean).join(' ') || '--')}
                    </td>
                    <td className="py-3 px-6 text-right">
                      <button
                        type="button"
                        onClick={() => void handleDeleteRecord(rec.sample_id)}
                        title="Delete dataset row"
                        className="p-1.5 text-[#64748B] hover:text-[#DC2626] rounded-md cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
