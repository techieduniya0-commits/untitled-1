import { jsPDF } from 'jspdf';
import type { AnalysisRecord, Classification, MediaType } from '../types/forensics';

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let idx = 0;
  let value = bytes;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx++;
  }
  return `${value >= 10 || idx === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[idx]}`;
}

export function formatDateTime(iso?: string | null): string {
  if (!iso) return 'Not available';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function mediaTypeLabel(type: MediaType | string): string {
  switch (type) {
    case 'image':
      return 'Image';
    case 'video':
      return 'Video';
    case 'audio':
      return 'Audio';
    case 'pdf':
      return 'PDF Document';
    case 'document':
      return 'Text Document';
    default:
      return type;
  }
}

export function classificationTone(classification?: Classification): {
  text: string;
  bar: string;
  surface: string;
} {
  switch (classification) {
    case 'Likely AI-generated':
      return { text: 'text-[#DC2626]', bar: 'bg-[#DC2626]', surface: 'bg-[#FEF2F2]' };
    case 'Potentially manipulated':
    case 'Potentially AI-assisted':
      return { text: 'text-[#D97706]', bar: 'bg-[#D97706]', surface: 'bg-[#FFFBEB]' };
    case 'Likely human-created':
      return { text: 'text-[#16A34A]', bar: 'bg-[#16A34A]', surface: 'bg-[#F0FDF4]' };
    default:
      return { text: 'text-[#64748B]', bar: 'bg-[#64748B]', surface: 'bg-[#F5F7FB]' };
  }
}

export function buildPlainTextSummary(analysis: AnalysisRecord): string {
  const scoring = analysis.scoring;
  const completed = analysis.detectors.filter(
    (d) =>
      d.status === 'completed' ||
      d.status === 'partially_completed' ||
      d.status === 'partially_implemented',
  );
  const failed = analysis.detectors.filter((d) => d.status === 'failed');
  const unavailable = analysis.detectors.filter((d) => d.status === 'unavailable');
  const detectedWms = analysis.watermarks.filter((w) => w.detected);
  const isPartial = Boolean(analysis.isPartialReport || analysis.status === 'partially_completed');

  const aiEvidence = scoring?.evidenceSupportingAi ?? [];
  const naturalEvidence = scoring?.evidenceSupportingNaturalCapture ?? [];
  const neutralEvidence = scoring?.neutralObservations ?? [];
  const disagreements = scoring?.disagreementReasons ?? [];

  const isUpdated = Boolean(
    analysis.isUpdatedReport && analysis.reanalysisSummary && analysis.userContext,
  );

  return [
    `TRUTHLENS FORENSIC REPORT${isUpdated ? ' (UPDATED)' : ''}${isPartial ? ' (PARTIAL)' : ''} — ${analysis.id}`,
    `File: ${analysis.fileName} (${mediaTypeLabel(analysis.mediaType)}, ${formatBytes(analysis.fileSizeBytes)})`,
    `SHA-256: ${analysis.fileHash}`,
    `Analysed: ${formatDateTime(analysis.completedDate || analysis.uploadDate)}`,
    ...(isPartial
      ? [
          `Report Completeness: PARTIAL — Gemini status: ${analysis.geminiStatus ?? 'failed'}${
            analysis.geminiFailureDetail ? ` (${analysis.geminiFailureDetail})` : ''
          }`,
        ]
      : []),
    '',
    `ASSESSMENT (EXPERIMENTAL ESTIMATE — NOT DEFINITIVE PROOF)`,
    `AI-Likelihood Score: ${scoring ? `${scoring.aiLikelihoodScore}/100 (${scoring.calibrationLabel})` : 'N/A'}`,
    `Classification: ${scoring?.classification ?? 'Pending'}`,
    `Evidence Strength: ${scoring?.evidenceStrength ?? 'N/A'} | Overall Reliability: ${scoring?.overallReliability ?? 'N/A'} | Completeness: ${scoring?.completenessPercent ?? 0}%`,
    `Methods Performed: ${completed.length} | Failed (Excluded): ${failed.length} | Unavailable: ${unavailable.length}`,
    ...(analysis.duplicateOfAnalysisId
      ? [`Duplicate SHA-256 Match: Previously analysed under ${analysis.duplicateOfAnalysisId}`]
      : []),
    ...(isUpdated && analysis.reanalysisSummary && analysis.userContext
      ? [
          '',
          `UPDATED REPORT & REANALYSIS COMPARISON`,
          `Score: ${analysis.reanalysisSummary.scoreBefore}/100 -> ${analysis.reanalysisSummary.scoreAfter}/100 (delta ${analysis.reanalysisSummary.scoreDelta >= 0 ? '+' : ''}${analysis.reanalysisSummary.scoreDelta})`,
          `Classification: ${analysis.reanalysisSummary.classificationBefore} -> ${analysis.reanalysisSummary.classificationAfter}`,
          `Evidence Strength: ${analysis.reanalysisSummary.evidenceStrengthBefore} -> ${analysis.reanalysisSummary.evidenceStrengthAfter}`,
          `Confidence Basis: ${analysis.reanalysisSummary.adjustmentJustification}`,
          `What Changed:`,
          ...analysis.reanalysisSummary.whatChanged.map((c) => `- ${c}`),
          ...(analysis.originalSnapshot
            ? [
                '',
                `ORIGINAL AUTOMATED ANALYSIS SNAPSHOT (${formatDateTime(analysis.originalSnapshot.capturedAt)})`,
                analysis.originalSnapshot.executiveSummary,
              ]
            : []),
          '',
          `USER-PROVIDED CONTEXT & STATEMENT (NOT INDEPENDENTLY VERIFIED EVIDENCE)`,
          ...analysis.userContext.answers.map((a) => `- Q: ${a.question}\n  A (User-reported): ${a.answer}`),
          ...(analysis.userContext.userStatement
            ? [`- User Statement (Verbatim, User-reported): "${analysis.userContext.userStatement}"`]
            : []),
          `Evidentiary Boundary: ${analysis.reanalysisSummary.epistemicSeparationNote}`,
        ]
      : []),
    '',
    `EXECUTIVE SUMMARY`,
    analysis.geminiSummary?.executiveSummary ?? 'Not available.',
    '',
    `EVIDENCE SUPPORTING AI GENERATION (${aiEvidence.length})`,
    ...(aiEvidence.length > 0 ? aiEvidence.map((e) => `- ${e}`) : ['- None observed by completed detectors.']),
    '',
    `EVIDENCE SUPPORTING NATURAL CAPTURE (${naturalEvidence.length})`,
    ...(naturalEvidence.length > 0
      ? naturalEvidence.map((e) => `- ${e}`)
      : ['- No explicit natural-capture indicators recorded.']),
    '',
    `NEUTRAL OBSERVATIONS (${neutralEvidence.length})`,
    ...(neutralEvidence.length > 0
      ? neutralEvidence.slice(0, 6).map((e) => `- ${e}`)
      : ['- None.']),
    ...(disagreements.length > 0
      ? ['', `CONFLICTING DETECTOR FINDINGS & WHY DETECTORS DISAGREED`, ...disagreements.map((d) => `- ${d}`)]
      : []),
    '',
    `WATERMARK & PROVENANCE FINDINGS`,
    detectedWms.length > 0
      ? detectedWms
          .map(
            (w) =>
              `- ${w.recognizedTextOrLogo} (${w.positionInFrame ?? 'unknown position'}${w.timestamp ? `, ${w.timestamp}` : ''}) — ${w.recognitionConfidence} confidence`,
          )
          .join('\n')
      : '- No visible AI-generator watermarks or provenance manifests detected (neutral — not proof of authenticity).',
    '',
    `CONFIDENCE LIMITATIONS`,
    ...(analysis.geminiSummary?.confidenceLimitations ?? [
      'A detection score is an estimate, not definitive proof of authorship.',
    ]).map((l) => `- ${l}`),
  ].join('\n');
}

export function exportForensicPdfReport(analysis: AnalysisRecord): void {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 44;
  const maxWidth = pageWidth - margin * 2;
  let y = 52;

  const ensureSpace = (needed: number) => {
    if (y + needed > pageHeight - 48) {
      doc.addPage();
      y = 48;
    }
  };

  const addSectionHeading = (title: string) => {
    ensureSpace(34);
    y += 10;
    doc.setDrawColor(229, 234, 242);
    doc.line(margin, y, pageWidth - margin, y);
    y += 18;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(23, 37, 84);
    doc.text(title, margin, y);
    y += 14;
  };

  const addBodyLines = (text: string, color: [number, number, number] = [51, 65, 85], fontSize = 9.5) => {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(fontSize);
    doc.setTextColor(...color);
    const lines = doc.splitTextToSize(text, maxWidth) as string[];
    for (const line of lines) {
      ensureSpace(14);
      doc.text(line, margin, y);
      y += 13;
    }
  };

  // Header
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.setTextColor(23, 37, 84);
  doc.text(
    analysis.isUpdatedReport
      ? 'TruthLens Updated Forensic Analysis Report'
      : analysis.isPartialReport || analysis.status === 'partially_completed'
        ? 'TruthLens Partial Forensic Report'
        : 'TruthLens Forensic Analysis Report',
    margin,
    y,
  );
  y += 18;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(100, 116, 139);
  doc.text(
    `Report ID: ${analysis.id}  |  Generated: ${formatDateTime(analysis.completedDate || analysis.uploadDate)}  |  Gemini: ${analysis.geminiStatus ?? 'completed'}`,
    margin,
    y,
  );
  y += 18;

  // Assessment Summary Box
  doc.setFillColor(245, 247, 251);
  doc.setDrawColor(229, 234, 242);
  doc.roundedRect(margin, y, maxWidth, 72, 4, 4, 'FD');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(23, 37, 84);
  doc.text(
    `AI-Likelihood Estimate: ${analysis.scoring?.aiLikelihoodScore ?? '--'}/100  —  ${analysis.scoring?.classification ?? 'Pending'}`,
    margin + 14,
    y + 24,
  );

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(100, 116, 139);
  doc.text(
    `Reliability: ${analysis.scoring?.overallReliability ?? '--'}  |  Completeness: ${analysis.scoring?.completenessPercent ?? 0}%  |  Run: ${analysis.scoring?.methodsPerformedCount ?? 0}  |  Failed: ${analysis.scoring?.methodsFailedCount ?? 0}  |  Unavail: ${analysis.scoring?.methodsUnavailableCount ?? 0}`,
    margin + 14,
    y + 42,
  );
  doc.text(
    'Notice: Experimental estimate, not definitive proof. API failures are never treated as AI evidence.',
    margin + 14,
    y + 58,
  );
  y += 88;

  // 1. File Info
  addSectionHeading('1. File & Integrity Information');
  addBodyLines(`Filename: ${analysis.fileName}`);
  addBodyLines(
    `Media Type: ${mediaTypeLabel(analysis.mediaType)}  |  Verified MIME: ${analysis.mimeType}  |  Size: ${formatBytes(analysis.fileSizeBytes)}`,
  );
  addBodyLines(`SHA-256 Hash: ${analysis.fileHash}`);
  if (analysis.duplicateOfAnalysisId) {
    addBodyLines(`Duplicate Hash Note: Identical file bytes were previously analysed under ${analysis.duplicateOfAnalysisId}.`);
  }
  if (analysis.videoSamplingStrategy) {
    addBodyLines(`Video Sampling Strategy: ${analysis.videoSamplingStrategy}`);
  }
  if (analysis.videoTelemetry) {
    const vt = analysis.videoTelemetry;
    const gopStr = vt.gopCounts
      ? `GOP I:${vt.gopCounts.I} P:${vt.gopCounts.P} B:${vt.gopCounts.B}`
      : 'GOP unavailable';
    addBodyLines(
      `Video Telemetry: ${vt.extractedFramesCount} extracted / ${vt.totalFramesEstimated ?? '?'} total (${vt.skippedFramesEstimated ?? '?'} skipped, ${vt.intervalSeconds}s interval) | Mean Bhattacharyya Sim: ${vt.meanHistogramSimilarity ?? 'N/A'} | ${gopStr}`,
    );
  }

  // 2. Executive Summary & Separated Evidence Buckets
  if (analysis.geminiSummary) {
    addSectionHeading('2. Executive Summary & Separated Evidence');
    addBodyLines(analysis.geminiSummary.executiveSummary);
    y += 4;
    addBodyLines(`Reasoning: ${analysis.geminiSummary.aiExplanation}`);
  }
  if (analysis.scoring) {
    const aiEv = analysis.scoring.evidenceSupportingAi ?? [];
    const natEv = analysis.scoring.evidenceSupportingNaturalCapture ?? [];
    const neutEv = analysis.scoring.neutralObservations ?? [];
    y += 4;
    addBodyLines(`Evidence Supporting AI Generation (${aiEv.length}):`, [185, 28, 28], 9.5);
    if (aiEv.length > 0) {
      for (const item of aiEv.slice(0, 6)) addBodyLines(`• ${item}`, [71, 85, 105], 8.5);
    } else {
      addBodyLines('• None observed by completed detectors.', [100, 116, 139], 8.5);
    }
    addBodyLines(`Evidence Supporting Natural Capture (${natEv.length}):`, [22, 163, 74], 9.5);
    if (natEv.length > 0) {
      for (const item of natEv.slice(0, 6)) addBodyLines(`• ${item}`, [71, 85, 105], 8.5);
    } else {
      addBodyLines('• No explicit natural-capture indicators recorded.', [100, 116, 139], 8.5);
    }
    addBodyLines(`Neutral Observations (${neutEv.length}):`, [100, 116, 139], 9.5);
    for (const item of neutEv.slice(0, 5)) addBodyLines(`• ${item}`, [100, 116, 139], 8.5);
  }

  // 3. Watermark & Provenance
  addSectionHeading('3. Watermark & Provenance Inspection');
  for (const wm of analysis.watermarks) {
    addBodyLines(
      `[${wm.type}] ${wm.detected ? `Detected: ${wm.recognizedTextOrLogo}` : 'Not detected'} — ${wm.detectionMethod} (${wm.recognitionConfidence}). ${wm.note}`,
    );
  }

  // 4. Detector Results
  addSectionHeading('4. Detector-by-Detector Findings');
  for (const det of analysis.detectors) {
    const scoreStr = det.rawSignalScore !== null ? `${det.rawSignalScore}/100` : 'Informational';
    const polStr = det.signalPolarity ? ` | ${det.signalPolarity}` : '';
    addBodyLines(
      `${det.methodName} [${det.status.toUpperCase()} | ${scoreStr}${polStr} | ${det.reliability} reliability]`,
      [23, 37, 84],
      9.5,
    );
    addBodyLines(`Result: ${det.resultSummary} (Tool: ${det.toolUsed})`, [71, 85, 105], 8.5);
    y += 3;
  }

  // 5. Conflicting Findings & Limitations
  addSectionHeading('5. Conflicting Findings, Limitations & Next Steps');
  if (analysis.scoring?.conflictingFindings.length) {
    addBodyLines(`Conflicting Findings: ${analysis.scoring.conflictingFindings.join(' ')}`, [180, 83, 9]);
  }
  if (analysis.scoring?.disagreementReasons?.length) {
    for (const reason of analysis.scoring.disagreementReasons) {
      addBodyLines(`Why detectors disagreed: ${reason}`, [146, 64, 14], 8.5);
    }
  }
  for (const lim of analysis.geminiSummary?.confidenceLimitations ?? []) {
    addBodyLines(`• ${lim}`);
  }
  for (const step of analysis.geminiSummary?.recommendedNextSteps ?? []) {
    addBodyLines(`Next step: ${step}`, [37, 99, 235]);
  }

  // 6. Updated Report Comparison & Separated User-Provided Context (if applicable)
  if (analysis.isUpdatedReport && analysis.reanalysisSummary && analysis.userContext) {
    addSectionHeading('6. Reanalysis Comparison & User-Provided Context (Unverified)');
    const rs = analysis.reanalysisSummary;
    addBodyLines(
      `Score: ${rs.scoreBefore}/100 -> ${rs.scoreAfter}/100  |  Classification: ${rs.classificationBefore} -> ${rs.classificationAfter}  |  Evidence Strength: ${rs.evidenceStrengthBefore} -> ${rs.evidenceStrengthAfter}`,
      [23, 37, 84],
      9.5,
    );
    addBodyLines(`Confidence Basis: ${rs.adjustmentJustification}`, [51, 65, 85], 9);
    for (const change of rs.whatChanged) {
      addBodyLines(`• ${change}`, [71, 85, 105], 8.5);
    }
    if (analysis.originalSnapshot) {
      y += 4;
      addBodyLines(
        `Original Automated Findings (${formatDateTime(analysis.originalSnapshot.capturedAt)}): ${analysis.originalSnapshot.executiveSummary}`,
        [71, 85, 105],
        8.5,
      );
    }
    y += 6;
    addBodyLines(
      'USER-PROVIDED CONTEXT & STATEMENT (NOT INDEPENDENTLY VERIFIED EVIDENCE):',
      [91, 33, 182],
      9.5,
    );
    for (const ans of analysis.userContext.answers) {
      addBodyLines(`Q: ${ans.question} -> User Answer: ${ans.answer}`, [51, 65, 85], 8.5);
    }
    if (analysis.userContext.userStatement) {
      addBodyLines(
        `User Statement (Verbatim): "${analysis.userContext.userStatement}"`,
        [23, 37, 84],
        9,
      );
    }
    addBodyLines(`Evidentiary Boundary: ${rs.epistemicSeparationNote}`, [91, 33, 182], 8.5);
  }

  doc.save(`truthlens-forensic-report-${analysis.id}.pdf`);
}
