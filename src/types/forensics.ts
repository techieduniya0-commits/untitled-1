export type MediaType = 'image' | 'video' | 'audio' | 'pdf' | 'document';

export type Classification =
  | 'Likely AI-generated'
  | 'Likely human-created'
  | 'Potentially AI-assisted'
  | 'Potentially manipulated'
  | 'Inconclusive';

export type EvidenceStrength = 'Low' | 'Moderate' | 'Strong';

export type MethodStatus =
  | 'pending'
  | 'retrying'
  | 'completed'
  | 'partially_completed'
  | 'partially_implemented'
  | 'unavailable'
  | 'failed'
  | 'skipped'
  | 'not_applicable';

export type PipelineStageId =
  | 'file_validation'
  | 'metadata_extraction'
  | 'media_preprocessing'
  | 'method_selection'
  | 'forensic_analysis'
  | 'ai_assessment'
  | 'evidence_aggregation'
  | 'report_generation';

export interface PipelineStage {
  id: PipelineStageId;
  label: string;
  status:
    | 'pending'
    | 'running'
    | 'retrying'
    | 'completed'
    | 'partially_completed'
    | 'warning'
    | 'failed'
    | 'unavailable';
  startedAt?: string;
  completedAt?: string;
  detail?: string;
}

export type EvidencePolarity = 'ai_indicator' | 'natural_capture' | 'neutral';

export interface DetectorResult {
  id: string;
  methodName: string;
  category:
    | 'provenance'
    | 'watermark'
    | 'signal'
    | 'visual'
    | 'temporal'
    | 'linguistic'
    | 'metadata'
    | 'ai_reasoning';
  status: MethodStatus;
  ran: boolean;
  resultSummary: string;
  rawSignalScore: number | null;
  signalPolarity?: EvidencePolarity;
  reliability: 'High' | 'Moderate' | 'Low' | 'Experimental';
  reliabilityWeight?: number;
  calibrationStatus: 'Calibrated' | 'Uncalibrated (Experimental)' | 'Deterministic Check';
  applicability: string;
  evidenceStrength: EvidenceStrength;
  evidence: string[];
  limitations: string[];
  toolUsed: string;
  correlationGroup: string;
  providerGroup?: string;
  durationMs?: number;
  detectorVersion?: string;
}

export interface WatermarkFinding {
  id: string;
  type: 'visible_text' | 'visible_logo' | 'invisible_watermark' | 'provenance_marker';
  detected: boolean;
  recognizedTextOrLogo: string | null;
  timestamp: string | null;
  frameIndex?: number | null;
  positionInFrame: string | null;
  detectionMethod: string;
  recognitionConfidence: 'High' | 'Moderate' | 'Low' | 'Not applicable';
  possiblePlatform: string | null;
  persistentAcrossFrames?: boolean;
  persistentFrameCount?: number;
  persistenceSummary?: string;
  cropImageUrl?: string | null;
  note: string;
}

export interface ExtractedMetadata {
  fileName: string;
  declaredMime: string;
  detectedMime: string;
  extension: string;
  fileSizeBytes: number;
  sha256: string;
  createdAt?: string | null;
  modifiedAt?: string | null;
  metadataPresent: boolean;
  warnings: string[];
  // Image specific
  width?: number | null;
  height?: number | null;
  colorMode?: string | null;
  channels?: number | null;
  hasAlpha?: boolean;
  iccProfile?: string | null;
  cameraMake?: string | null;
  cameraModel?: string | null;
  software?: string | null;
  gpsPresent?: boolean;
  gpsSummary?: string | null;
  exif?: Record<string, string | number | boolean | null>;
  embeddedMetadataKeys?: string[];
  // Video specific
  containerFormat?: string | null;
  videoCodec?: string | null;
  audioCodec?: string | null;
  durationSeconds?: number | null;
  frameRate?: number | null;
  videoBitrate?: number | null;
  frameCount?: number | null;
  encoder?: string | null;
  tags?: Record<string, string>;
  // Audio specific
  audioFormat?: string | null;
  sampleRate?: number | null;
  bitrate?: number | null;
  audioChannels?: number | null;
  codec?: string | null;
  // Document / PDF specific
  title?: string | null;
  author?: string | null;
  creator?: string | null;
  producer?: string | null;
  creationDate?: string | null;
  modificationDate?: string | null;
  pageCount?: number | null;
  wordCount?: number | null;
  characterCount?: number | null;
  fonts?: string[];
  embeddedImageCount?: number | null;
  documentStructure?: string | null;
  // Provenance
  c2paStatus: 'present_unverified' | 'absent' | 'unavailable';
  c2paDetails?: string | null;
}

export interface VideoFrameSample {
  frameIndex: number;
  timestampSec: number;
  timestampLabel: string;
  thumbnailFile: string;
  thumbnailUrl: string;
  suspicious: boolean;
  anomalyScore: number;
  interFrameDiff: number | null;
  histogramSimilarity?: number | null;
  sceneChange: boolean;
  observations: string[];
  watermarkDetected: boolean;
  watermarkDetail?: string | null;
}

export interface VideoForensicTelemetry {
  totalFramesEstimated: number | null;
  extractedFramesCount: number;
  skippedFramesEstimated: number | null;
  intervalSeconds: number;
  meanHistogramSimilarity: number | null;
  gopPatternSample: string | null;
  gopCounts: { I: number; P: number; B: number } | null;
  frameDeltaVariance?: number | null;
  cameraCharacteristicsDetected?: string[];
  socialMediaReencodeLikely?: boolean;
  adaptiveSamplingApplied?: boolean;
  interpolationNote?: string;
}

export interface ImageVisualMetrics {
  laplacianVariance: number;
  quadrantNoiseSpread: number;
  noiseResidualIndex: number;
  channelEntropy: { r: number; g: number; b: number };
  elaMeanDiff: number;
  elaMaxDiff: number;
  doubleCompressionDelta?: number;
  highFreqEnergyRatio: number;
  edgeDensity: number;
  aspectRatio: string;
  ocrExtractedText: string[];
  suspiciousRegions: Array<{
    label: string;
    region: string;
    observation: string;
  }>;
}

export interface DocumentSegmentFinding {
  index: number;
  excerpt: string;
  indicatorLevel: 'neutral' | 'notable' | 'elevated';
  reason: string;
}

export interface DocumentStats {
  sentenceCount: number;
  wordCount: number;
  avgSentenceLength: number;
  sentenceLengthStdDev: number;
  lexicalDiversity: number;
  repeatedNgramRate: number;
  burstinessScore: number;
  paragraphCount: number;
}

export interface AudioSegmentFinding {
  startSec: number;
  endSec: number;
  timestampLabel: string;
  rmsDb: number;
  zeroCrossingRate: number;
  observation: string;
  flagged: boolean;
}

export interface AudioProfile {
  waveformPeaks: number[];
  spectralCentroidHz: number | null;
  highFreqEnergyRatio: number | null;
  silenceRatio: number;
  dynamicRangeDb: number;
  clippingRate: number;
  noiseFloorDb?: number | null;
  spectralFlatness?: number | null;
  speechDetected?: boolean;
  syntheticIndicatorCount?: number;
  detectedIndicators?: string[];
  uncertainSignals?: string[];
  naturalCues?: string[];
  segments: AudioSegmentFinding[];
}

export interface MethodContribution {
  methodName: string;
  rawScore: number | null;
  weightApplied: number;
  correlationGroup: string;
  status: MethodStatus;
  reliability: DetectorResult['reliability'];
  signalPolarity?: EvidencePolarity;
  reason: string;
}

export interface ScoringBreakdown {
  aiLikelihoodScore: number;
  isExperimental: boolean;
  calibrationLabel: string;
  evidenceStrength: EvidenceStrength;
  classification: Classification;
  completenessPercent: number;
  overallReliability: 'Low' | 'Moderate' | 'High';
  methodsPerformedCount: number;
  methodsUnavailableCount: number;
  methodsFailedCount: number;
  conflictingFindings: string[];
  disagreementReasons: string[];
  evidenceSupportingAi: string[];
  evidenceSupportingNaturalCapture: string[];
  neutralObservations: string[];
  scoreExplanation: string[];
  methodContributions: MethodContribution[];
}

export interface GeminiForensicSummary {
  executiveSummary: string;
  observedEvidence: string[];
  aiExplanation: string;
  suspiciousIndicators: string[];
  evidenceSupportingAi?: string[];
  evidenceSupportingNaturalCapture?: string[];
  neutralObservations?: string[];
  disagreementReasons?: string[];
  technicalObservations: string[];
  recommendedNextSteps: string[];
  confidenceLimitations: string[];
  modelUsed: string;
  generatedAt: string;
}

export interface FollowUpQuestion {
  id: string;
  category:
    | 'missing_metadata'
    | 'conflicting_signals'
    | 'incomplete_pipeline'
    | 'audio_context'
    | 'capture_origin'
    | 'editing_history';
  question: string;
  whyAsked: string;
  suggestedChoices?: string[];
  placeholder: string;
}

export interface UserFollowUpAnswer {
  questionId: string;
  question: string;
  answer: string;
}

export interface UserProvidedContext {
  submittedAt: string;
  answers: UserFollowUpAnswer[];
  userStatement: string;
  rerunAutomatedDetectors: boolean;
}

export interface OriginalAnalysisSnapshot {
  capturedAt: string;
  status: 'needs_context' | 'completed' | 'partially_completed' | 'failed';
  aiLikelihoodScore: number;
  classification: Classification;
  evidenceStrength: EvidenceStrength;
  overallReliability: 'Low' | 'Moderate' | 'High';
  completenessPercent: number;
  methodsPerformedCount: number;
  methodsFailedCount: number;
  evidenceSupportingAi: string[];
  evidenceSupportingNaturalCapture: string[];
  neutralObservations: string[];
  conflictingFindings: string[];
  executiveSummary: string;
}

export interface ReanalysisChangeSummary {
  updatedAt: string;
  scoreBefore: number;
  scoreAfter: number;
  scoreDelta: number;
  classificationBefore: Classification;
  classificationAfter: Classification;
  evidenceStrengthBefore: EvidenceStrength;
  evidenceStrengthAfter: EvidenceStrength;
  confidenceAdjusted: boolean;
  adjustmentJustification: string;
  whatChanged: string[];
  epistemicSeparationNote: string;
}

export interface AnalysisRecord {
  id: string;
  fileName: string;
  mediaType: MediaType;
  uploadDate: string;
  completedDate?: string;
  fileHash: string;
  fileSizeBytes: number;
  mimeType: string;
  status: 'processing' | 'needs_context' | 'completed' | 'partially_completed' | 'failed';
  errorMessage?: string;
  errorCode?: string;
  geminiStatus?: 'completed' | 'partially_completed' | 'failed' | 'unavailable' | 'retrying' | 'not_run';
  geminiModelUsed?: string | null;
  geminiFailureDetail?: string | null;
  isPartialReport?: boolean;
  canRetryGemini?: boolean;
  retryCount?: number;
  duplicateOfAnalysisId?: string;
  stages: PipelineStage[];
  mediaRetained: boolean;
  mediaExpiresAt?: string;
  previewUrl?: string;
  metadata?: ExtractedMetadata;
  detectors: DetectorResult[];
  watermarks: WatermarkFinding[];
  scoring?: ScoringBreakdown;
  geminiSummary?: GeminiForensicSummary;
  videoFrames?: VideoFrameSample[];
  videoSamplingStrategy?: string;
  videoTelemetry?: VideoForensicTelemetry;
  imageVisualMetrics?: ImageVisualMetrics;
  documentSegments?: DocumentSegmentFinding[];
  documentStats?: DocumentStats;
  audioProfile?: AudioProfile;
  insufficiencyReasons?: string[];
  followUpQuestions?: FollowUpQuestion[];
  originalSnapshot?: OriginalAnalysisSnapshot;
  userContext?: UserProvidedContext;
  reanalysisSummary?: ReanalysisChangeSummary;
  isUpdatedReport?: boolean;
}

export type GroundTruthLabel =
  | 'REAL'
  | 'AI_GENERATED'
  | 'AI_ASSISTED'
  | 'MANIPULATED'
  | 'UNKNOWN';

export type DatasetSplit = 'train' | 'validation' | 'test' | 'live_upload';

export interface DatasetRecord {
  sample_id: string;
  file_name: string;
  media_type: MediaType | string;
  ground_truth_label: GroundTruthLabel;
  generation_platform: string;
  generation_model: string;
  creation_method: string;
  visible_watermark: boolean;
  watermark_text: string;
  invisible_watermark_status: string;
  c2pa_status: string;
  mime_type: string;
  file_size_bytes: number | null;
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
  frame_rate: number | null;
  codec: string;
  creation_timestamp: string;
  modification_timestamp: string;
  encoder: string;
  exif_software: string;
  camera_make: string;
  camera_model: string;
  metadata_present: boolean;
  compression_level: string;
  editing_history: string;
  manipulation_type: string;
  dataset_source: string;
  license: string;
  consent_status: string;
  split: DatasetSplit;
  notes: string;
  file_hash?: string;
  is_illustrative_seed?: boolean;
  recording_condition?: string;
  predicted_score?: number | null;
  predicted_classification?: Classification | '';
  linked_analysis_id?: string;
}

export interface BenchmarkConditionMetrics {
  condition: string;
  sampleCount: number;
  realCount: number;
  aiCount: number;
  meanScore: number;
  accuracy: number | null;
  fpr: number | null;
  fnr: number | null;
}

export interface BenchmarkEvaluationReport {
  evaluatedAt: string;
  thresholdUsed: number;
  eligibleCount: number;
  nonSeedTotal: number;
  unlinkedLabeledCount: number;
  positiveCount: number;
  negativeCount: number;
  confusionMatrix: { tp: number; fp: number; tn: number; fn: number };
  accuracy: number | null;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  fpr: number | null;
  fnr: number | null;
  rocAuc: number | null;
  inconclusiveRate: number | null;
  meanRealScore: number | null;
  meanAiScore: number | null;
  byCondition: BenchmarkConditionMetrics[];
  calibrationNotes: string[];
}

export interface DatasetValidationSummary {
  totalRecords: number;
  illustrativeSeedCount: number;
  splitCounts: Record<DatasetSplit, number>;
  labelCounts: Record<GroundTruthLabel, number>;
  mediaTypeCounts: Record<string, number>;
  duplicateSampleIds: string[];
  duplicateHashes: string[];
  crossSplitLeakageWarnings: string[];
  missingMetadataCount: number;
  missingConsentOrLicenseCount: number;
  invalidRows: Array<{ sample_id: string; issues: string[] }>;
}

export interface AppSettings {
  retainOriginalMediaHours: number;
  videoFrameSampleCount: number;
  maxUploadSizeMb: number;
  storageBackend: string;
  storageNotice: string;
}

export interface SystemCapabilities {
  ffmpegAvailable: boolean;
  ffprobeAvailable: boolean;
  sharpAvailable: boolean;
  geminiConfigured: boolean;
  synthIdVerifierAvailable: boolean;
  c2paCryptographicVerifierAvailable: boolean;
  storageMode: string;
  geminiModel: string;
}
