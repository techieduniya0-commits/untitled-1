import { Type, ThinkingLevel } from '@google/genai';
import type {
  AnalysisRecord,
  DetectorResult,
  ExtractedMetadata,
  GeminiForensicSummary,
  MediaType,
  ScoringBreakdown,
  WatermarkFinding,
} from '../../src/types/forensics.ts';
import { runStructuredGeminiAnalysisWithMeta } from '../geminiClient.ts';

interface GeminiNarrativeOutput {
  executiveSummary: string;
  aiExplanation: string;
  suspiciousIndicators: string[];
  technicalObservations: string[];
  recommendedNextSteps: string[];
  confidenceLimitations: string[];
}

const REPORT_NARRATIVE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    executiveSummary: { type: Type.STRING },
    aiExplanation: { type: Type.STRING },
    suspiciousIndicators: { type: Type.ARRAY, items: { type: Type.STRING } },
    technicalObservations: { type: Type.ARRAY, items: { type: Type.STRING } },
    recommendedNextSteps: { type: Type.ARRAY, items: { type: Type.STRING } },
    confidenceLimitations: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: [
    'executiveSummary',
    'aiExplanation',
    'suspiciousIndicators',
    'technicalObservations',
    'recommendedNextSteps',
    'confidenceLimitations',
  ],
};

function buildDeterministicSummary(options: {
  mediaType: MediaType;
  detectors: DetectorResult[];
  observedEvidence: string[];
  scoring: ScoringBreakdown;
  geminiStatus?: AnalysisRecord['geminiStatus'];
  geminiFailureDetail?: string | null;
  reason: string;
}): GeminiForensicSummary {
  const { mediaType, detectors, observedEvidence, scoring, geminiStatus, geminiFailureDetail, reason } = options;
  const failedDetectors = detectors.filter((d) => d.status === 'failed');
  const partiallyCompletedDetectors = detectors.filter((d) => d.status === 'partially_completed');
  const unavailableDetectors = detectors.filter((d) => d.status === 'unavailable');

  const isPartial = failedDetectors.length > 0 || geminiStatus === 'failed' || geminiStatus === 'partially_completed';

  const suspiciousIndicators = scoring.evidenceSupportingAi.length > 0
    ? scoring.evidenceSupportingAi
    : detectors
        .filter((d) => d.ran && d.rawSignalScore !== null && d.rawSignalScore >= 60)
        .map((d) => `${d.methodName} (${d.rawSignalScore}/100): ${d.resultSummary}`);

  const executiveSummary = isPartial
    ? `Partial forensic report compiled for this ${mediaType} specimen: ${scoring.methodsPerformedCount} local/independent detector(s) completed while ${failedDetectors.length} Gemini-backed detector(s) failed due to temporary API unavailability (${unavailableDetectors.length} additional method(s) unavailable in runtime). Based exclusively on completed checks, the classification is ${scoring.classification} (${scoring.aiLikelihoodScore}/100 Experimental, ${scoring.overallReliability} reliability).`
    : `Forensic analysis completed ${scoring.methodsPerformedCount} detector(s) with an experimental AI-likelihood estimate of ${scoring.aiLikelihoodScore}/100 (${scoring.classification}, ${scoring.overallReliability} overall reliability, ${scoring.completenessPercent}% completeness). Observed ${scoring.evidenceSupportingAi.length} AI-supporting indicator(s), ${scoring.evidenceSupportingNaturalCapture.length} natural-capture cue(s), and ${scoring.neutralObservations.length} neutral observation(s).`;

  const aiExplanation = isPartial
    ? `Gemini multimodal reasoning did not complete (${geminiFailureDetail || reason}). All failed detectors were strictly excluded from evidence aggregation so upstream service errors never bias the result toward AI generation. ${
        partiallyCompletedDetectors.length > 0
          ? `${partiallyCompletedDetectors.length} hybrid detector(s) preserved their deterministic local measurements.`
          : 'All completed deterministic local measurements and extracted artifacts are preserved below.'
      }`
    : `Narrative synthesis fell back to deterministic summary because upstream AI reasoning returned an error (${reason}). All local forensic metrics, evidence polarity buckets, and scoring breakdowns remain intact below.`;

  const technicalObservations = [
    ...scoring.scoreExplanation,
    ...(scoring.disagreementReasons.length > 0 ? scoring.disagreementReasons : []),
    ...(failedDetectors.length > 0
      ? [
          `Failed (recoverable) detectors excluded from scoring: ${failedDetectors
            .map((d) => d.methodName)
            .join(', ')}.`,
        ]
      : []),
    ...(unavailableDetectors.length > 0
      ? [
          `Unavailable detectors not installed in this runtime: ${unavailableDetectors
            .map((d) => d.methodName)
            .join(', ')}.`,
        ]
      : []),
  ];

  const recommendedNextSteps = [
    ...(isPartial
      ? [
          'Use "Retry Gemini Analysis" to run the failed multimodal detectors once upstream Gemini demand subsides — extracted video frames and metadata are cached on disk and will be reused without repeating preprocessing.',
        ]
      : []),
    ...(scoring.conflictingFindings.length > 0
      ? [
          'Inspect the conflicting detector findings manually and request the original, un-reencoded camera file to resolve ambiguity between compression/processing and synthetic artifacts.',
        ]
      : []),
    'Verify original source provenance, capture device chain-of-custody, and unedited raw files where available.',
    'Review the completed deterministic telemetry (container metadata, C2PA markers, frame/pixel/acoustic signals) independently alongside human inspection.',
  ];

  const confidenceLimitations = [
    'A detection score is an experimental estimate, not definitive proof of AI generation or human authorship.',
    'Absence of AI watermarks or C2PA provenance metadata is neutral and does not prove authenticity or AI generation.',
    ...(isPartial
      ? [
          `Gemini multimodal analysis status: ${geminiStatus ?? 'failed'} (${geminiFailureDetail || reason}). Conclusions rely exclusively on the ${scoring.methodsPerformedCount} detector(s) that genuinely executed.`,
          'Upstream API failures are never interpreted as evidence of AI generation.',
        ]
      : [
          'AI narrative synthesis was unavailable during this run; conclusions rely solely on completed detectors.',
        ]),
  ];

  return {
    executiveSummary,
    observedEvidence,
    aiExplanation,
    suspiciousIndicators:
      suspiciousIndicators.length > 0
        ? suspiciousIndicators
        : [
            isPartial
              ? 'No elevated AI-generation indicators were flagged by the completed deterministic detectors (multimodal visual/watermark checks did not complete).'
              : 'No high-scoring synthetic indicators were flagged by completed detectors.',
          ],
    evidenceSupportingAi: scoring.evidenceSupportingAi,
    evidenceSupportingNaturalCapture: scoring.evidenceSupportingNaturalCapture,
    neutralObservations: scoring.neutralObservations,
    disagreementReasons: scoring.disagreementReasons,
    technicalObservations,
    recommendedNextSteps,
    confidenceLimitations,
    modelUsed: 'Deterministic partial-report engine (Gemini unavailable)',
    generatedAt: new Date().toISOString(),
  };
}

export async function generateForensicReportNarrative(options: {
  mediaType: MediaType;
  metadata: ExtractedMetadata;
  detectors: DetectorResult[];
  watermarks: WatermarkFinding[];
  scoring: ScoringBreakdown;
  samplingStrategy?: string;
  geminiStatus?: AnalysisRecord['geminiStatus'];
  geminiFailureDetail?: string | null;
  skipGeminiNarrative?: boolean;
  userContext?: AnalysisRecord['userContext'];
  originalSnapshot?: AnalysisRecord['originalSnapshot'];
}): Promise<GeminiForensicSummary> {
  const {
    mediaType,
    metadata,
    detectors,
    watermarks,
    scoring,
    samplingStrategy,
    geminiStatus,
    geminiFailureDetail,
    skipGeminiNarrative,
    userContext,
    originalSnapshot,
  } = options;

  // Deterministic observed evidence list assembled strictly from real detector outputs (never generated by LLM)
  const observedEvidence: string[] = [];
  for (const d of detectors) {
    if (
      (d.status === 'completed' ||
        d.status === 'partially_completed' ||
        d.status === 'partially_implemented') &&
      d.ran
    ) {
      observedEvidence.push(`[${d.methodName}] ${d.resultSummary}`);
    }
  }
  const visibleWatermarks = watermarks.filter((w) => w.detected && w.type !== 'invisible_watermark');
  for (const wm of visibleWatermarks) {
    observedEvidence.push(
      `[Watermark] ${wm.recognizedTextOrLogo} at ${wm.positionInFrame ?? 'unknown position'}${wm.timestamp ? ` (${wm.timestamp})` : ''} — confidence: ${wm.recognitionConfidence}.`,
    );
  }

  if (skipGeminiNarrative) {
    return buildDeterministicSummary({
      mediaType,
      detectors,
      observedEvidence,
      scoring,
      geminiStatus,
      geminiFailureDetail,
      reason: geminiFailureDetail || 'Gemini multimodal service was unavailable during forensic analysis.',
    });
  }

  const completedSummary = detectors
    .filter(
      (d) =>
        (d.status === 'completed' ||
          d.status === 'partially_completed' ||
          d.status === 'partially_implemented') &&
        d.ran,
    )
    .map(
      (d) =>
        `- ${d.methodName} [${d.status}, polarity=${d.signalPolarity ?? 'auto'}] (score: ${d.rawSignalScore ?? 'informational'}, reliability: ${d.reliability}): ${d.resultSummary} | Evidence: ${d.evidence.slice(0, 2).join(' ; ')}`,
    )
    .join('\n');

  const failedSummary = detectors
    .filter((d) => d.status === 'failed')
    .map((d) => `- ${d.methodName}: ${d.resultSummary}`)
    .join('\n');

  const unavailableSummary = detectors
    .filter((d) => d.status === 'unavailable')
    .map((d) => `- ${d.methodName}: ${d.resultSummary}`)
    .join('\n');

  const userContextBlock = userContext
    ? [
        '',
        '=== USER-PROVIDED CONTEXT (UNVERIFIED — NEVER TREAT AS INDEPENDENTLY VERIFIED EVIDENCE) ===',
        ...userContext.answers
          .filter((a) => a.answer.trim().length > 0)
          .map((a) => `- Q: ${a.question}\n  User Answer (unverified): ${a.answer}`),
        userContext.userStatement.trim()
          ? `- User Statement (unverified): ${userContext.userStatement.trim()}`
          : '',
        originalSnapshot
          ? `Original Automated Analysis Before Follow-Up: ${originalSnapshot.aiLikelihoodScore}/100 (${originalSnapshot.classification}, ${originalSnapshot.evidenceStrength} evidence strength, ${originalSnapshot.methodsPerformedCount} methods completed, ${originalSnapshot.methodsFailedCount} failed).`
          : '',
        'CRITICAL REPORTING RULE: Acknowledge the user-provided context clearly as UNVERIFIED USER CONTEXT separate from objectively detected findings. Explain whether user context offers a plausible contextual explanation for missing metadata or conflicting signals, while explicitly affirming that user opinions do NOT override objective detector evidence.',
      ]
        .filter(Boolean)
        .join('\n')
    : '';

  const prompt = [
    'Synthesize a clear, balanced, non-exaggerated TruthLens forensic report summary based EXCLUSIVELY on the observed detector results below.',
    'DO NOT invent any new watermarks, EXIF tags, timestamps, C2PA credentials, or scores.',
    'Never claim 100% proof or definitive authorship. Never treat a failed API detector, missing metadata, or absent watermarks as proof of AI generation or authenticity.',
    'Clearly acknowledge natural-capture observations when present, and explain WHY individual detectors disagreed if conflicting findings exist.',
    '',
    `File: ${metadata.fileName} (${mediaType}, ${metadata.detectedMime}, ${metadata.fileSizeBytes} bytes)`,
    `Overall Experimental AI-Likelihood Score: ${scoring.aiLikelihoodScore}/100`,
    `Classification: ${scoring.classification}`,
    `Evidence Strength: ${scoring.evidenceStrength} | Overall Reliability: ${scoring.overallReliability}`,
    `Gemini Multimodal Status: ${geminiStatus ?? 'completed'}`,
    samplingStrategy ? `Video Sampling Strategy: ${samplingStrategy}` : '',
    '',
    `Evidence Supporting AI Generation (${scoring.evidenceSupportingAi.length}):`,
    scoring.evidenceSupportingAi.length ? scoring.evidenceSupportingAi.map((e) => `- ${e}`).join('\n') : '- None observed',
    '',
    `Evidence Supporting Natural Capture (${scoring.evidenceSupportingNaturalCapture.length}):`,
    scoring.evidenceSupportingNaturalCapture.length ? scoring.evidenceSupportingNaturalCapture.map((e) => `- ${e}`).join('\n') : '- None observed',
    '',
    `Neutral Observations (${scoring.neutralObservations.length}):`,
    scoring.neutralObservations.length ? scoring.neutralObservations.slice(0, 6).map((e) => `- ${e}`).join('\n') : '- None',
    '',
    `Conflicting Findings: ${scoring.conflictingFindings.length ? scoring.conflictingFindings.join(' ') : 'None'}`,
    `Disagreement Explanations: ${scoring.disagreementReasons.length ? scoring.disagreementReasons.join(' ') : 'None'}`,
    '',
    'Completed & Partially Completed Detector Outputs:',
    completedSummary || 'None',
    '',
    'Failed Detectors (Recoverable — Excluded from Scoring):',
    failedSummary || 'None',
    '',
    'Unavailable Methods (Not Performed):',
    unavailableSummary || 'None',
    userContextBlock,
    '',
    'Return structured JSON with:',
    '- executiveSummary: 2-3 clear sentences explaining the classification, balancing AI-supporting vs natural-capture evidence, and (if user context was provided) clearly separating objectively detected findings from user-supplied context.',
    '- aiExplanation: concise plain-English explanation of why the scoring engine produced this estimate and (if applicable) why individual detectors disagreed or what changed after reanalysis.',
    '- suspiciousIndicators: bullet list of concrete AI/manipulation indicators observed (or explicit note that none stood out).',
    '- technicalObservations: concise technical notes grounded strictly in the telemetry above.',
    '- recommendedNextSteps: practical human verification steps.',
    '- confidenceLimitations: clear limitations of this assessment.',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const res = await runStructuredGeminiAnalysisWithMeta<GeminiNarrativeOutput>({
      parts: [{ text: prompt }],
      responseSchema: REPORT_NARRATIVE_SCHEMA,
      thinkingLevel: ThinkingLevel.LOW,
      timeoutMs: 28_000,
    });
    const narrative = res.data;

    return {
      executiveSummary: narrative.executiveSummary,
      observedEvidence,
      aiExplanation: narrative.aiExplanation,
      suspiciousIndicators: Array.isArray(narrative.suspiciousIndicators)
        ? narrative.suspiciousIndicators
        : [],
      evidenceSupportingAi: scoring.evidenceSupportingAi,
      evidenceSupportingNaturalCapture: scoring.evidenceSupportingNaturalCapture,
      neutralObservations: scoring.neutralObservations,
      disagreementReasons: scoring.disagreementReasons,
      technicalObservations: Array.isArray(narrative.technicalObservations)
        ? narrative.technicalObservations
        : [],
      recommendedNextSteps: Array.isArray(narrative.recommendedNextSteps)
        ? narrative.recommendedNextSteps
        : [],
      confidenceLimitations: [
        'A detection score is an experimental estimate, not definitive proof of AI generation or human authorship.',
        'Absence of AI watermarks or C2PA metadata is neutral context and never establishes definitive authenticity.',
        ...(Array.isArray(narrative.confidenceLimitations) ? narrative.confidenceLimitations : []),
      ],
      modelUsed: res.modelUsed,
      generatedAt: new Date().toISOString(),
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'Upstream narrative model unavailable';
    return buildDeterministicSummary({
      mediaType,
      detectors,
      observedEvidence,
      scoring,
      geminiStatus,
      geminiFailureDetail,
      reason,
    });
  }
}
