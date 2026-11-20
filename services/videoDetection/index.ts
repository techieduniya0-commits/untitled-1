import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { Type, ThinkingLevel } from '@google/genai';
import sharp from 'sharp';
import type {
  DetectorResult,
  EvidencePolarity,
  ExtractedMetadata,
  VideoForensicTelemetry,
  VideoFrameSample,
  WatermarkFinding,
} from '../../src/types/forensics.ts';
import { MAX_IMAGE_PIXELS } from '../fileValidation.ts';
import {
  type ForensicContentPart,
  GEMINI_FORENSIC_MODEL,
  type GeminiRetryEvent,
  runStructuredGeminiAnalysisWithMeta,
} from '../geminiClient.ts';
import type { ProvenanceInspectionOutput } from '../provenanceVerification/index.ts';
import { runWatermarkDetection } from '../watermarkDetection/index.ts';

const execFileAsync = promisify(execFile);

interface GeminiVideoForensicsResponse {
  aiVideoLikelihoodScore: number;
  aiVideoSummary: string;
  aiVideoEvidence: string[];
  naturalCaptureEvidence: string[];
  temporalAnomalyScore: number;
  temporalSummary: string;
  temporalEvidence: string[];
  lightingAnomalyScore: number;
  lightingSummary: string;
  lightingEvidence: string[];
  backgroundAnomalyScore: number;
  backgroundSummary: string;
  backgroundEvidence: string[];
  syntheticMotionAnomalyScore: number;
  syntheticMotionSummary: string;
  syntheticMotionEvidence: string[];
  cameraCharacteristicsSummary: string;
  sceneTransitionSummary: string;
  facesDetected: boolean;
  facialAnomalyScore: number | null;
  facialSummary: string;
  facialEvidence: string[];
  blinkingAndMovementAnomalyScore: number | null;
  blinkingAndMovementSummary: string;
  skinTextureAnomalyScore: number | null;
  skinTextureSummary: string;
  speechAndVisibleFaceDetected: boolean;
  lipSyncSummary: string;
  frameAssessments: Array<{
    frameIndex: number;
    suspicious: boolean;
    anomalyScore: number;
    observations: string[];
  }>;
}

const VIDEO_FORENSICS_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    aiVideoLikelihoodScore: { type: Type.INTEGER },
    aiVideoSummary: { type: Type.STRING },
    aiVideoEvidence: { type: Type.ARRAY, items: { type: Type.STRING } },
    naturalCaptureEvidence: { type: Type.ARRAY, items: { type: Type.STRING } },
    temporalAnomalyScore: { type: Type.INTEGER },
    temporalSummary: { type: Type.STRING },
    temporalEvidence: { type: Type.ARRAY, items: { type: Type.STRING } },
    lightingAnomalyScore: { type: Type.INTEGER },
    lightingSummary: { type: Type.STRING },
    lightingEvidence: { type: Type.ARRAY, items: { type: Type.STRING } },
    backgroundAnomalyScore: { type: Type.INTEGER },
    backgroundSummary: { type: Type.STRING },
    backgroundEvidence: { type: Type.ARRAY, items: { type: Type.STRING } },
    syntheticMotionAnomalyScore: { type: Type.INTEGER },
    syntheticMotionSummary: { type: Type.STRING },
    syntheticMotionEvidence: { type: Type.ARRAY, items: { type: Type.STRING } },
    cameraCharacteristicsSummary: { type: Type.STRING },
    sceneTransitionSummary: { type: Type.STRING },
    facesDetected: { type: Type.BOOLEAN },
    facialAnomalyScore: { type: Type.INTEGER, nullable: true },
    facialSummary: { type: Type.STRING },
    facialEvidence: { type: Type.ARRAY, items: { type: Type.STRING } },
    blinkingAndMovementAnomalyScore: { type: Type.INTEGER, nullable: true },
    blinkingAndMovementSummary: { type: Type.STRING },
    skinTextureAnomalyScore: { type: Type.INTEGER, nullable: true },
    skinTextureSummary: { type: Type.STRING },
    speechAndVisibleFaceDetected: { type: Type.BOOLEAN },
    lipSyncSummary: { type: Type.STRING },
    frameAssessments: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          frameIndex: { type: Type.INTEGER },
          suspicious: { type: Type.BOOLEAN },
          anomalyScore: { type: Type.INTEGER },
          observations: { type: Type.ARRAY, items: { type: Type.STRING } },
        },
        required: ['frameIndex', 'suspicious', 'anomalyScore', 'observations'],
      },
    },
  },
  required: [
    'aiVideoLikelihoodScore',
    'aiVideoSummary',
    'aiVideoEvidence',
    'naturalCaptureEvidence',
    'temporalAnomalyScore',
    'temporalSummary',
    'temporalEvidence',
    'lightingAnomalyScore',
    'lightingSummary',
    'lightingEvidence',
    'backgroundAnomalyScore',
    'backgroundSummary',
    'backgroundEvidence',
    'syntheticMotionAnomalyScore',
    'syntheticMotionSummary',
    'syntheticMotionEvidence',
    'cameraCharacteristicsSummary',
    'sceneTransitionSummary',
    'facesDetected',
    'facialSummary',
    'facialEvidence',
    'blinkingAndMovementSummary',
    'skinTextureSummary',
    'speechAndVisibleFaceDetected',
    'lipSyncSummary',
    'frameAssessments',
  ],
};

function formatTimestamp(sec: number): string {
  const safe = Math.max(0, sec);
  const mins = Math.floor(safe / 60);
  const rem = safe - mins * 60;
  return `${String(mins).padStart(2, '0')}:${rem.toFixed(1).padStart(4, '0')}`;
}

function classifyPolarity(score: number | null): EvidencePolarity {
  if (score === null || !Number.isFinite(score)) return 'neutral';
  if (score >= 60) return 'ai_indicator';
  if (score <= 38) return 'natural_capture';
  return 'neutral';
}

function clampScore(value: number | null | undefined, fallback = 50): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(5, Math.min(95, Math.round(value)));
}

async function computeInterFrameMetrics(
  framePathA: string,
  framePathB: string,
): Promise<{ pixelDiffPct: number; bhattacharyyaSim: number }> {
  const [a, b] = await Promise.all([
    sharp(framePathA, { limitInputPixels: MAX_IMAGE_PIXELS })
      .resize(160, 90, { fit: 'fill' })
      .grayscale()
      .raw()
      .toBuffer(),
    sharp(framePathB, { limitInputPixels: MAX_IMAGE_PIXELS })
      .resize(160, 90, { fit: 'fill' })
      .grayscale()
      .raw()
      .toBuffer(),
  ]);

  const bins = 32;
  const histA = new Float64Array(bins);
  const histB = new Float64Array(bins);
  let diffSum = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    diffSum += Math.abs(a[i] - b[i]);
    histA[Math.min(bins - 1, a[i] >> 3)] += 1;
    histB[Math.min(bins - 1, b[i] >> 3)] += 1;
  }

  let bc = 0;
  if (len > 0) {
    for (let k = 0; k < bins; k++) {
      bc += Math.sqrt((histA[k] / len) * (histB[k] / len));
    }
  }

  return {
    pixelDiffPct: len > 0 ? Number(((diffSum / len / 255) * 100).toFixed(2)) : 0,
    bhattacharyyaSim: Number(Math.min(1, Math.max(0, bc)).toFixed(3)),
  };
}

async function inspectVideoGopStructure(filePath: string): Promise<{
  patternSample: string | null;
  counts: { I: number; P: number; B: number } | null;
}> {
  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-read_intervals',
        '%+4',
        '-show_entries',
        'frame=pict_type',
        '-of',
        'csv=p=0',
        filePath,
      ],
      { timeout: 12_000, maxBuffer: 512 * 1024 },
    );
    const types = stdout
      .split(/\r?\n/)
      .map((s) => s.trim().replace(/,$/, ''))
      .filter((s) => s === 'I' || s === 'P' || s === 'B')
      .slice(0, 90);
    if (types.length === 0) return { patternSample: null, counts: null };

    const counts = { I: 0, P: 0, B: 0 };
    for (const t of types) {
      if (t === 'I') counts.I++;
      else if (t === 'P') counts.P++;
      else if (t === 'B') counts.B++;
    }
    return {
      patternSample: types.slice(0, 32).join(''),
      counts,
    };
  } catch {
    return { patternSample: null, counts: null };
  }
}

interface CameraMetadataFindings {
  cameraCharacteristics: string[];
  socialMediaReencodeLikely: boolean;
  encoderMatchesAi: boolean;
  cameraHardwareTagDetected: boolean;
}

/**
 * Deterministic inspection of video container/stream metadata to recognize genuine smartphone/DSLR
 * capture signatures vs. social-media/editor re-encoding vs. known AI video encoders.
 * Never treats missing metadata or social-media re-encoding as evidence of AI generation.
 */
function inspectCameraAndEncodingMetadata(metadata: ExtractedMetadata): CameraMetadataFindings {
  const tags = metadata.tags ?? {};
  const tagEntries = Object.entries(tags);
  const tagBlob = tagEntries.map(([k, v]) => `${k}=${v}`).join(' | ');
  const encoder = metadata.encoder ?? '';
  const combined = `${encoder} ${metadata.containerFormat ?? ''} ${tagBlob}`;

  const encoderAiPattern = /veo|sora|runway|kling|pika|luma|hailuo|synthesia|heygen|minimax|seedance/i;
  const encoderMatchesAi = Boolean(encoder && encoderAiPattern.test(encoder));

  const cameraCharacteristics: string[] = [];
  let cameraHardwareTagDetected = false;

  const appleMake = tags['com.apple.quicktime.make'] || tags['make'];
  const appleModel = tags['com.apple.quicktime.model'] || tags['model'];
  const androidVer = tags['com.android.version'] || tags['com.android.capture.fps'];
  const gpsLoc = tags['location'] || tags['com.apple.quicktime.location.ISO6709'];
  const majorBrand = tags['major_brand'] ?? '';
  const creationTime = tags['creation_time'] || tags['com.apple.quicktime.creationdate'];

  if (appleMake || appleModel) {
    cameraHardwareTagDetected = true;
    cameraCharacteristics.push(
      `Device capture tags present: ${[appleMake, appleModel].filter(Boolean).join(' ')}`,
    );
  }
  if (androidVer) {
    cameraHardwareTagDetected = true;
    cameraCharacteristics.push(`Android camera container tag present (${androidVer})`);
  }
  if (/\b(iphone|ipad|apple|samsung|galaxy|pixel|sony|canon|nikon|fujifilm|panasonic|gopro|dji|insta360|blackmagic|red digital)\b/i.test(combined)) {
    cameraHardwareTagDetected = true;
    const match = combined.match(
      /\b(iphone|ipad|apple|samsung|galaxy|pixel|sony|canon|nikon|fujifilm|panasonic|gopro|dji|insta360|blackmagic|red digital)\b/i,
    );
    if (match && !cameraCharacteristics.some((c) => c.toLowerCase().includes(match[1].toLowerCase()))) {
      cameraCharacteristics.push(`Camera/smartphone hardware reference detected (${match[1]})`);
    }
  }
  if (majorBrand.trim().toLowerCase() === 'qt') {
    cameraCharacteristics.push('Native QuickTime (qt) container brand common to iOS/cinema cameras');
  }
  if (gpsLoc) {
    cameraCharacteristics.push('Embedded ISO6709 capture location metadata present');
  }
  if (creationTime) {
    cameraCharacteristics.push(`Container creation timestamp recorded (${creationTime})`);
  }

  // Detect standard social media / editor re-encoding signatures (strictly neutral context)
  const socialMediaReencodeLikely =
    !cameraHardwareTagDetected &&
    !encoderMatchesAi &&
    (/lavf|ffmpeg|handbrake|x264|x265|facebook|fbmd|instagram|tiktok|whatsapp|youtube/i.test(combined) ||
      (tagEntries.length <= 2 && Boolean(metadata.videoCodec)));

  if (socialMediaReencodeLikely) {
    cameraCharacteristics.push(
      'Container tags resemble social-media, messaging, or editor re-encoding (stripped original camera headers — neutral context)',
    );
  }

  return {
    cameraCharacteristics,
    socialMediaReencodeLikely,
    encoderMatchesAi,
    cameraHardwareTagDetected,
  };
}

function computeFrameDeltaVariance(diffs: Array<number | null>): {
  variance: number | null;
  meanDelta: number | null;
  interpolationNote: string;
} {
  const valid = diffs.filter((d): d is number => d !== null && Number.isFinite(d));
  if (valid.length < 2) {
    return {
      variance: null,
      meanDelta: valid[0] ?? null,
      interpolationNote: 'Insufficient frame pairs to evaluate motion delta variance.',
    };
  }
  const mean = valid.reduce((a, b) => a + b, 0) / valid.length;
  const variance = valid.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / valid.length;
  const roundedVar = Number(variance.toFixed(2));
  const roundedMean = Number(mean.toFixed(2));

  let interpolationNote = `Natural inter-frame delta spread across sampled intervals (mean ${roundedMean}%, variance ${roundedVar}).`;
  if (roundedMean < 1.2 && roundedVar < 0.3) {
    interpolationNote = `Very steady scene across sampled frames (mean delta ${roundedMean}%, variance ${roundedVar}) — typical of tripod/selfie talking-head footage or static camera capture (NOT an AI indicator on its own).`;
  } else if (roundedVar > 120) {
    interpolationNote = `High motion/cut delta variance (${roundedVar}) indicating active camera motion, rapid subject movement, or scene cuts.`;
  }

  return { variance: roundedVar, meanDelta: roundedMean, interpolationNote };
}

export interface VideoPipelineOutput {
  detectors: DetectorResult[];
  watermarks: WatermarkFinding[];
  videoFrames: VideoFrameSample[];
  videoSamplingStrategy: string;
  videoTelemetry: VideoForensicTelemetry;
  geminiStatus: 'completed' | 'partially_completed' | 'failed';
  geminiModelUsed: string | null;
  geminiFailureDetail: string | null;
  reusedCachedFrames: boolean;
}

export async function runVideoDetectionPipeline(options: {
  analysisId: string;
  filePath: string;
  framesOutputDir: string;
  cropsOutputDir: string;
  metadata: ExtractedMetadata;
  provenance: ProvenanceInspectionOutput;
  targetFrameCount: number;
  reuseExistingFrames?: VideoFrameSample[];
  reuseSamplingStrategy?: string;
  onStageProgress?: (
    stageId: 'media_preprocessing' | 'forensic_analysis' | 'ai_assessment',
    detail: string,
    statusOverride?: 'running' | 'retrying',
  ) => void;
}): Promise<VideoPipelineOutput> {
  const {
    analysisId,
    filePath,
    framesOutputDir,
    cropsOutputDir,
    metadata,
    provenance,
    targetFrameCount,
    reuseExistingFrames,
    reuseSamplingStrategy,
    onStageProgress,
  } = options;

  await fs.mkdir(framesOutputDir, { recursive: true });

  const duration = metadata.durationSeconds && metadata.durationSeconds > 0 ? metadata.durationSeconds : 4;
  const clampedCount = Math.max(4, Math.min(10, targetFrameCount || 6));

  const extractedFrames: Array<{
    frameIndex: number;
    timestampSec: number;
    timestampLabel: string;
    filePath: string;
    thumbnailFile: string;
  }> = [];

  let reusedCachedFrames = false;
  let adaptiveSamplingApplied = false;

  if (reuseExistingFrames && reuseExistingFrames.length > 0) {
    let allPresent = true;
    for (const existing of reuseExistingFrames) {
      const candidatePath = path.join(framesOutputDir, existing.thumbnailFile);
      try {
        const stat = await fs.stat(candidatePath);
        if (stat.size <= 0) {
          allPresent = false;
          break;
        }
      } catch {
        allPresent = false;
        break;
      }
    }
    if (allPresent) {
      reusedCachedFrames = true;
      for (const existing of reuseExistingFrames) {
        extractedFrames.push({
          frameIndex: existing.frameIndex,
          timestampSec: existing.timestampSec,
          timestampLabel: existing.timestampLabel,
          filePath: path.join(framesOutputDir, existing.thumbnailFile),
          thumbnailFile: existing.thumbnailFile,
        });
      }
      onStageProgress?.(
        'media_preprocessing',
        `Reusing ${extractedFrames.length} previously extracted FFmpeg frames from disk cache (preprocessing skipped).`,
      );
    }
  }

  let sampleTimestamps: number[] = extractedFrames.map((f) => f.timestampSec);

  const extractSingleFrame = async (ts: number, outPath: string): Promise<boolean> => {
    try {
      await execFileAsync(
        'ffmpeg',
        [
          '-y',
          '-ss',
          String(ts),
          '-i',
          filePath,
          '-frames:v',
          '1',
          '-vf',
          'scale=960:-2',
          '-q:v',
          '3',
          outPath,
        ],
        { timeout: 20_000 },
      );
      const stat = await fs.stat(outPath);
      return stat.size > 0;
    } catch {
      return false;
    }
  };

  if (!reusedCachedFrames) {
    sampleTimestamps = [];
    // Representative sampling: allocate uniform full-duration base frames, reserving 1-2 adaptive slots for longer clips (> 6s)
    const reserveAdaptive = duration > 6 && clampedCount >= 6 ? 2 : 0;
    const baseCount = Math.max(4, clampedCount - reserveAdaptive);

    if (duration <= 1.2) {
      const count = 4;
      for (let i = 0; i < count; i++) {
        sampleTimestamps.push(Number(((i / count) * Math.max(0.4, duration * 0.9)).toFixed(2)));
      }
    } else {
      const margin = Math.min(0.35, duration * 0.05);
      const span = Math.max(0.5, duration - margin * 2);
      for (let i = 0; i < baseCount; i++) {
        const t = margin + (span * i) / Math.max(1, baseCount - 1);
        sampleTimestamps.push(Number(t.toFixed(2)));
      }
    }

    onStageProgress?.(
      'media_preprocessing',
      `Extracting ${sampleTimestamps.length} representative frames with FFmpeg${reserveAdaptive > 0 ? ' (with adaptive transition pass)' : ''}.`,
    );

    const rawFrames: Array<{ timestampSec: number; filePath: string }> = [];
    for (let i = 0; i < sampleTimestamps.length; i++) {
      const ts = sampleTimestamps[i];
      const tempPath = path.join(framesOutputDir, `tmp_base_${i}.jpg`);
      if (await extractSingleFrame(ts, tempPath)) {
        rawFrames.push({ timestampSec: ts, filePath: tempPath });
      }
    }

    // Adaptive refinement: if duration > 6s and we reserved adaptive slots, inspect largest inter-frame motion/scene jump and extract midpoint frame(s)
    if (reserveAdaptive > 0 && rawFrames.length >= 3) {
      const pairDeltas: Array<{ idx: number; delta: number; midTs: number }> = [];
      for (let i = 1; i < rawFrames.length; i++) {
        const m = await computeInterFrameMetrics(rawFrames[i - 1].filePath, rawFrames[i].filePath);
        const midTs = Number(((rawFrames[i - 1].timestampSec + rawFrames[i].timestampSec) / 2).toFixed(2));
        pairDeltas.push({ idx: i, delta: m.pixelDiffPct, midTs });
      }
      pairDeltas.sort((a, b) => b.delta - a.delta);
      const chosenAdaptive = pairDeltas.slice(0, reserveAdaptive);
      for (let a = 0; a < chosenAdaptive.length; a++) {
        const extraPath = path.join(framesOutputDir, `tmp_adapt_${a}.jpg`);
        if (await extractSingleFrame(chosenAdaptive[a].midTs, extraPath)) {
          rawFrames.push({ timestampSec: chosenAdaptive[a].midTs, filePath: extraPath });
          adaptiveSamplingApplied = true;
        }
      }
      rawFrames.sort((a, b) => a.timestampSec - b.timestampSec);
    }

    if (rawFrames.length === 0) {
      const fallbackOut = path.join(framesOutputDir, 'frame_00.jpg');
      await execFileAsync(
        'ffmpeg',
        ['-y', '-i', filePath, '-frames:v', '1', '-vf', 'scale=960:-2', '-q:v', '3', fallbackOut],
        { timeout: 20_000 },
      );
      extractedFrames.push({
        frameIndex: 0,
        timestampSec: 0,
        timestampLabel: '00:00.0',
        filePath: fallbackOut,
        thumbnailFile: 'frame_00.jpg',
      });
    } else {
      for (let i = 0; i < rawFrames.length; i++) {
        const fileName = `frame_${String(i).padStart(2, '0')}.jpg`;
        const finalPath = path.join(framesOutputDir, fileName);
        await fs.rename(rawFrames[i].filePath, finalPath);
        extractedFrames.push({
          frameIndex: i,
          timestampSec: rawFrames[i].timestampSec,
          timestampLabel: formatTimestamp(rawFrames[i].timestampSec),
          filePath: finalPath,
          thumbnailFile: fileName,
        });
      }
    }
    sampleTimestamps = extractedFrames.map((f) => f.timestampSec);
  }

  const intervalSec =
    sampleTimestamps.length > 1
      ? Number(
          (
            (sampleTimestamps[sampleTimestamps.length - 1] - sampleTimestamps[0]) /
            (sampleTimestamps.length - 1)
          ).toFixed(2),
        )
      : 0;

  const totalFramesEst = metadata.frameCount ?? (metadata.frameRate ? Math.round(duration * metadata.frameRate) : null);
  const skippedFramesEst = totalFramesEst ? Math.max(0, totalFramesEst - extractedFrames.length) : null;
  const samplingStrategy =
    reuseSamplingStrategy ||
    `${adaptiveSamplingApplied ? 'Adaptive + uniform sampling' : 'Uniform sampling'} · Total frames: ${totalFramesEst ?? 'unknown'} · Extracted: ${extractedFrames.length} · Skipped: ${skippedFramesEst ?? 'unknown'} · Mean interval: ~${intervalSec}s across ${duration.toFixed(2)}s (${formatTimestamp(sampleTimestamps[0] ?? 0)} to ${formatTimestamp(sampleTimestamps[sampleTimestamps.length - 1] ?? 0)}).`;

  onStageProgress?.(
    'forensic_analysis',
    'Computing inter-frame deltas, Bhattacharyya similarity, camera metadata signatures, GOP structure, and cross-frame watermark tracking.',
  );

  const interFrameDiffs: Array<number | null> = [null];
  const histSimilarities: Array<number | null> = [null];
  const sceneCuts: number[] = [];

  for (let i = 1; i < extractedFrames.length; i++) {
    const metrics = await computeInterFrameMetrics(
      extractedFrames[i - 1].filePath,
      extractedFrames[i].filePath,
    );
    interFrameDiffs.push(metrics.pixelDiffPct);
    histSimilarities.push(metrics.bhattacharyyaSim);
    if (metrics.pixelDiffPct >= 22 || metrics.bhattacharyyaSim < 0.78) {
      sceneCuts.push(i);
    }
  }

  const validSims = histSimilarities.filter((v): v is number => v !== null);
  const meanHistogramSimilarity =
    validSims.length > 0
      ? Number((validSims.reduce((a, b) => a + b, 0) / validSims.length).toFixed(3))
      : null;

  const deltaStats = computeFrameDeltaVariance(interFrameDiffs);
  const camMeta = inspectCameraAndEncodingMetadata(metadata);

  const tLocalStart = Date.now();
  const gopPromise = inspectVideoGopStructure(filePath);
  const wmPromise = runWatermarkDetection({
    analysisId,
    mediaType: 'video',
    frames: extractedFrames.map((f) => ({
      frameIndex: f.frameIndex,
      timestampLabel: f.timestampLabel,
      filePath: f.filePath,
    })),
    cropsOutputDir,
    onRetry: (evt: GeminiRetryEvent) => {
      onStageProgress?.(
        'forensic_analysis',
        `Watermark OCR retrying (${evt.attempt}/${evt.totalAttempts} → ${evt.nextModel} in ${(evt.delayMs / 1000).toFixed(1)}s): ${evt.reason}`,
        'retrying',
      );
    },
  });

  const [gopInfo, wmResult] = await Promise.all([gopPromise, wmPromise]);
  const localDurationMs = Date.now() - tLocalStart;

  // Multimodal frame-sequence forensic inspection via Gemini (fault-isolated — never discards local detectors!)
  onStageProgress?.(
    'ai_assessment',
    `Evaluating ${extractedFrames.length} frames for human-capture authenticity vs. synthetic artifacts (facial landmarks, blinking, skin texture, background, lighting, motion).`,
  );

  const parts: ForensicContentPart[] = [];
  for (const frame of extractedFrames) {
    const buf = await sharp(frame.filePath, { limitInputPixels: MAX_IMAGE_PIXELS })
      .resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    parts.push({
      text: `[Frame ${frame.frameIndex} | Timestamp ${frame.timestampLabel} | Inter-frame luminance delta: ${interFrameDiffs[frame.frameIndex] ?? 'N/A'}% | Bhattacharyya similarity: ${histSimilarities[frame.frameIndex] ?? 'N/A'}]`,
    });
    parts.push({
      inlineData: {
        mimeType: 'image/jpeg',
        data: buf.toString('base64'),
      },
    });
  }

  parts.push({
    text: [
      'Perform calibrated multi-frame forensic analysis on these sequentially sampled video frames.',
      `Sampling Strategy: ${samplingStrategy}`,
      `Container Metadata: Codec=${metadata.videoCodec ?? 'Unknown'}, Audio=${metadata.audioCodec ?? 'None'}, Resolution=${metadata.width ?? '?'}x${metadata.height ?? '?'}, FPS=${metadata.frameRate ?? '?'}, Encoder=${metadata.encoder ?? 'None'}`,
      `Camera / Container Context: ${camMeta.cameraCharacteristics.length ? camMeta.cameraCharacteristics.join('; ') : 'No device-specific tags present (neutral — common after social media re-encoding)'}`,
      `Dedicated Watermark Module Finding: ${wmResult.watermarkDetector.resultSummary}`,
      '',
      'CRITICAL ANTI-FALSE-POSITIVE SCORING SCALE (ALL *_Score FIELDS FOLLOW THIS EXACT DIRECTIONALITY):',
      '- 5 to 28 = CLEARLY NATURAL CAMERA CAPTURE (consistent human facial geometry/landmarks, natural blinking/micro-expressions, organic skin/hair/fabric grain, coherent background, plausible optical lens/smartphone HDR/EIS or normal H.264/social-media compression).',
      '- 29 to 39 = MOSTLY NATURAL CAPTURE (natural footage with minor compression softness, low-light noise, or motion blur).',
      '- 40 to 59 = NEUTRAL / INCONCLUSIVE (default to this band whenever you do NOT observe concrete synthetic-generation or face-swap defects).',
      '- 60 to 74 = MODERATE CONCRETE AI OR MANIPULATION INDICATORS (must cite specific directly visible artifacts: e.g., morphing fingers/teeth/text, face-swap jawline blending seam, temporal identity drift, or uncanny synthetic motion).',
      '- 75 to 95 = STRONG CONCRETE AI-GENERATION OR DEEPFAKE DEFECTS visible across multiple frames.',
      '',
      'DO NOT MISCLASSIFY GENUINE HUMAN VIDEOS AS AI:',
      '- Consistent facial landmarks, stable identity, high Bhattacharyya similarity (0.90–0.999), stable indoor/daylight illumination, static room backgrounds, smooth smartphone EIS stabilization, and natural speech posture are NORMAL in authentic human camera recordings -> score these LOW (10–30), NEVER high!',
      '- Smartphone computational noise reduction, portrait bokeh, low-light sensor grain, and social-media H.264/AAC re-encoding are NOT AI generation artifacts.',
      '- Absence of watermarks or C2PA tags is NEUTRAL, not evidence of authenticity or AI.',
      '',
      'Evaluate each dimension carefully:',
      '1. aiVideoLikelihoodScore + aiVideoEvidence + naturalCaptureEvidence: Overall assessment separating concrete synthetic artifacts from authentic optical/human capture cues.',
      '2. temporalAnomalyScore: Check for temporal warping, object permanence failures, or background morphing. Stable real-world scenes = LOW score (10-28).',
      '3. lightingAnomalyScore: Check for physically impossible shadow/reflection contradictions. Stable or naturally shifting camera auto-exposure = LOW score (10-30).',
      '4. backgroundAnomalyScore: Check for melting/warping background lines, garbled signage/text, or inconsistent background geometry. Normal static room/street background = LOW score (10-28).',
      '5. syntheticMotionAnomalyScore: Check for frame-interpolation ghosting halos, unnatural morph-blending around moving hands/hair, or floaty AI-video physics. Natural camera motion or steady tripod/selfie framing = LOW score (10-30).',
      '6. Faces (ONLY if human faces are clearly visible; otherwise set facesDetected=false and facialAnomalyScore/blinkingAndMovementAnomalyScore/skinTextureAnomalyScore=null):',
      '   - facialAnomalyScore: Facial identity stability & landmark coherence (consistent natural landmarks = LOW 10-28; face-swap seam, jawline halo, or warping eyes/teeth/ears = HIGH 65-90).',
      '   - blinkingAndMovementAnomalyScore: Natural blinking, eye gaze, head turns, and micro-expressions (natural organic movement = LOW 10-28; robotic/frozen stare or unnatural lip/jaw warping = HIGH 65-85).',
      '   - skinTextureAnomalyScore: Skin pores, natural creases, facial hair, and texture continuity with neck/ears (organic camera/compressed skin = LOW 10-30; plastic diffusion waxiness or face-swap sharpness mismatch at face border = HIGH 65-88).',
      '7. cameraCharacteristicsSummary: Note optical sensor grain, depth-of-field, motion blur, rolling shutter/EIS, or compression cues consistent with real camera vs synthetic render.',
      '8. Provide an entry in frameAssessments for every provided frameIndex (mark suspicious=true ONLY if a concrete visual defect is observed in that frame).',
    ].join('\n'),
  });

  const tAiStart = Date.now();
  let aiVideo: GeminiVideoForensicsResponse | null = null;
  let aiVideoModelUsed: string | null = null;
  let aiVideoError: string | null = null;

  try {
    const aiRes = await runStructuredGeminiAnalysisWithMeta<GeminiVideoForensicsResponse>({
      parts,
      responseSchema: VIDEO_FORENSICS_SCHEMA,
      thinkingLevel: ThinkingLevel.LOW,
      timeoutMs: 32_000,
      onRetry: (evt: GeminiRetryEvent) => {
        onStageProgress?.(
          'ai_assessment',
          `Gemini retrying (${evt.attempt}/${evt.totalAttempts} → ${evt.nextModel} in ${(evt.delayMs / 1000).toFixed(1)}s): ${evt.reason}`,
          'retrying',
        );
      },
    });
    aiVideo = aiRes.data;
    aiVideoModelUsed = aiRes.modelUsed;
  } catch (err) {
    aiVideoError =
      err instanceof Error ? err.message : 'Gemini multimodal video inspection failed unexpectedly.';
  }
  const aiDurationMs = Date.now() - tAiStart;

  const assessmentByIdx = new Map(
    (aiVideo?.frameAssessments ?? []).map((fa) => [fa.frameIndex, fa]),
  );

  const videoFrames: VideoFrameSample[] = extractedFrames.map((f) => {
    const fa = assessmentByIdx.get(f.frameIndex);
    const wmNote = wmResult.perFrameWatermarkMap.get(f.frameIndex) ?? null;
    const diff = interFrameDiffs[f.frameIndex] ?? null;
    const sim = histSimilarities[f.frameIndex] ?? null;
    const isSceneCut = (diff !== null && diff >= 22) || (sim !== null && sim < 0.78);
    const frameScore = aiVideo ? clampScore(fa?.anomalyScore, 35) : 50;
    return {
      frameIndex: f.frameIndex,
      timestampSec: f.timestampSec,
      timestampLabel: f.timestampLabel,
      thumbnailFile: f.thumbnailFile,
      thumbnailUrl: `/api/analyses/${analysisId}/frames/${f.thumbnailFile}`,
      suspicious: Boolean((fa?.suspicious && frameScore >= 60) || wmNote),
      anomalyScore: frameScore,
      interFrameDiff: diff,
      histogramSimilarity: sim,
      sceneChange: isSceneCut,
      observations: fa?.observations?.length
        ? fa.observations
        : aiVideo
          ? ['Sampled frame inspected; no isolated frame-specific synthesis defect observed.']
          : [
              `Frame extracted via FFmpeg${diff !== null ? ` (inter-frame pixel delta ${diff}%, Bhattacharyya similarity ${sim ?? 'N/A'})` : ''}. Gemini visual review did not complete; retry available.`,
            ],
      watermarkDetected: Boolean(wmNote),
      watermarkDetail: wmNote,
    };
  });

  const suspiciousFrames = videoFrames.filter((f) => f.suspicious);
  const avgFrameAnomaly =
    videoFrames.length > 0
      ? Math.round(videoFrames.reduce((acc, f) => acc + f.anomalyScore, 0) / videoFrames.length)
      : 50;

  const hasAudioTrack = Boolean(metadata.audioCodec && metadata.audioCodec !== 'None detected');

  // Resolve calibrated scores & polarities for Gemini sub-detectors
  const aiOverallScore = aiVideo ? clampScore(aiVideo.aiVideoLikelihoodScore) : null;
  const temporalScore = aiVideo ? clampScore(aiVideo.temporalAnomalyScore) : null;
  const lightingScore = aiVideo ? clampScore(aiVideo.lightingAnomalyScore) : null;
  const backgroundScore = aiVideo ? clampScore(aiVideo.backgroundAnomalyScore) : null;
  const syntheticMotionScore = aiVideo ? clampScore(aiVideo.syntheticMotionAnomalyScore) : null;
  const facialScore =
    aiVideo && aiVideo.facesDetected && typeof aiVideo.facialAnomalyScore === 'number'
      ? clampScore(aiVideo.facialAnomalyScore)
      : null;
  const blinkingScore =
    aiVideo && aiVideo.facesDetected && typeof aiVideo.blinkingAndMovementAnomalyScore === 'number'
      ? clampScore(aiVideo.blinkingAndMovementAnomalyScore)
      : null;
  const skinScore =
    aiVideo && aiVideo.facesDetected && typeof aiVideo.skinTextureAnomalyScore === 'number'
      ? clampScore(aiVideo.skinTextureAnomalyScore)
      : null;

  const detectors: DetectorResult[] = [
    {
      id: 'video_frame_extraction',
      methodName: 'Representative & Adaptive Multi-Frame Extraction',
      category: 'temporal',
      status: 'completed',
      ran: true,
      resultSummary: samplingStrategy,
      rawSignalScore: null,
      signalPolarity: 'neutral',
      reliability: 'High',
      reliabilityWeight: 0.9,
      calibrationStatus: 'Deterministic Check',
      applicability: 'Full-duration uniform + adaptive transition sampling',
      evidenceStrength: 'Moderate',
      evidence: [
        samplingStrategy,
        reusedCachedFrames
          ? `Reused ${extractedFrames.length} cached keyframes on disk without repeating FFmpeg extraction.`
          : `Successfully decoded ${extractedFrames.length} keyframes${adaptiveSamplingApplied ? ' including adaptive midpoint transition frames' : ''} for multi-layer inspection.`,
      ],
      limitations: [
        'Short transient artifacts occurring strictly between sampled timestamps may not be captured.',
      ],
      toolUsed: 'FFmpeg Adaptive Frame Sampler',
      correlationGroup: 'frame_sampling',
      providerGroup: 'deterministic_signal',
      durationMs: localDurationMs,
      detectorVersion: '3.0',
    },
    aiVideo
      ? {
          id: 'frame_by_frame_ai_detection',
          methodName: 'Frame-by-Frame AI Artifact Inspection',
          category: 'visual',
          status: 'completed',
          ran: true,
          resultSummary:
            suspiciousFrames.length > 0
              ? `Inspected ${videoFrames.length} frames; ${suspiciousFrames.length} frame(s) flagged with concrete visual or watermark anomalies (mean frame signal ${avgFrameAnomaly}/100).`
              : `Inspected ${videoFrames.length} frames; no isolated frame-level AI synthesis artifacts detected (mean frame signal ${avgFrameAnomaly}/100).`,
          rawSignalScore: clampScore(avgFrameAnomaly),
          signalPolarity: classifyPolarity(avgFrameAnomaly),
          reliability: 'Experimental',
          reliabilityWeight: 0.45,
          calibrationStatus: 'Uncalibrated (Experimental)',
          applicability: `${videoFrames.length} timestamped frames`,
          evidenceStrength: suspiciousFrames.length >= 2 || avgFrameAnomaly <= 28 ? 'Moderate' : 'Low',
          evidence:
            suspiciousFrames.length > 0
              ? suspiciousFrames
                  .slice(0, 5)
                  .map(
                    (sf) =>
                      `Frame #${sf.frameIndex} (${sf.timestampLabel}): ${sf.observations[0]}${sf.watermarkDetail ? ` [Watermark: ${sf.watermarkDetail}]` : ''}`,
                  )
              : [
                  ...(Array.isArray(aiVideo.naturalCaptureEvidence)
                    ? aiVideo.naturalCaptureEvidence.slice(0, 3)
                    : []),
                  'No isolated frame-level visual synthesis defects stood out across sampled timestamps.',
                ],
          limitations: [
            'Motion blur and H.264/VP9 compression softness can occasionally reduce fine detail on genuine camera footage.',
          ],
          toolUsed: `FFmpeg + Gemini Frame Sequence Analysis (${aiVideoModelUsed ?? GEMINI_FORENSIC_MODEL})`,
          correlationGroup: 'video_gemini_visual',
          providerGroup: 'gemini_multimodal',
          durationMs: aiDurationMs,
          detectorVersion: '3.0',
        }
      : {
          id: 'frame_by_frame_ai_detection',
          methodName: 'Frame-by-Frame AI Artifact Inspection',
          category: 'visual',
          status: 'failed',
          ran: false,
          resultSummary: `Failed (recoverable) — Gemini visual frame inspection unavailable: ${aiVideoError}`,
          rawSignalScore: null,
          signalPolarity: 'neutral',
          reliability: 'Experimental',
          reliabilityWeight: 0.45,
          calibrationStatus: 'Uncalibrated (Experimental)',
          applicability: `${videoFrames.length} timestamped frames`,
          evidenceStrength: 'Low',
          evidence: [
            `${videoFrames.length} frames were extracted and preserved on disk, but Gemini visual artifact classification failed after retries.`,
            `Upstream error: ${aiVideoError}`,
          ],
          limitations: [
            'Excluded from scoring — API errors are never treated as evidence of AI generation.',
          ],
          toolUsed: `Gemini Frame Sequence Analysis (${GEMINI_FORENSIC_MODEL})`,
          correlationGroup: 'video_gemini_visual',
          providerGroup: 'gemini_multimodal',
          durationMs: aiDurationMs,
          detectorVersion: '3.0',
        },
    aiVideo
      ? {
          id: 'facial_landmark_analysis',
          methodName: 'Facial Landmark & Identity Consistency',
          category: 'visual',
          status: aiVideo.facesDetected ? 'partially_implemented' : 'not_applicable',
          ran: aiVideo.facesDetected,
          resultSummary: aiVideo.facesDetected
            ? aiVideo.facialSummary
            : 'Not applicable — no clearly visible human faces detected in sampled frames.',
          rawSignalScore: facialScore,
          signalPolarity: classifyPolarity(facialScore),
          reliability: 'Experimental',
          reliabilityWeight: 0.48,
          calibrationStatus: 'Uncalibrated (Experimental)',
          applicability: 'Applies only where human faces appear in frames',
          evidenceStrength:
            aiVideo.facesDetected && facialScore !== null && (facialScore >= 65 || facialScore <= 30)
              ? 'Moderate'
              : 'Low',
          evidence:
            aiVideo.facesDetected && Array.isArray(aiVideo.facialEvidence) && aiVideo.facialEvidence.length > 0
              ? aiVideo.facialEvidence
              : ['No clear facial regions present in sampled frames.'],
          limitations: [
            'Consistent facial landmarks are normal in authentic human videos and are never scored as an AI indicator. Visual review is not a dedicated MediaPipe/dlib 68-point geometric landmark tracker.',
          ],
          toolUsed: aiVideo.facesDetected
            ? `Gemini Visual Face Consistency Review (${aiVideoModelUsed ?? GEMINI_FORENSIC_MODEL})`
            : 'Skipped (no faces)',
          correlationGroup: 'video_gemini_human_face',
          providerGroup: 'gemini_multimodal',
          durationMs: aiDurationMs,
          detectorVersion: '3.0',
        }
      : {
          id: 'facial_landmark_analysis',
          methodName: 'Facial Landmark & Identity Consistency',
          category: 'visual',
          status: 'failed',
          ran: false,
          resultSummary: `Failed (recoverable) — Gemini visual face review did not execute: ${aiVideoError}`,
          rawSignalScore: null,
          signalPolarity: 'neutral',
          reliability: 'Experimental',
          reliabilityWeight: 0.48,
          calibrationStatus: 'Uncalibrated (Experimental)',
          applicability: 'Applies only where human faces appear in frames',
          evidenceStrength: 'Low',
          evidence: ['Multimodal face consistency review failed due to upstream Gemini unavailability.'],
          limitations: ['No local MediaPipe/dlib landmark model is installed; retry Gemini analysis to run visual review.'],
          toolUsed: `Gemini Visual Face Consistency Review (${GEMINI_FORENSIC_MODEL})`,
          correlationGroup: 'video_gemini_human_face',
          providerGroup: 'gemini_multimodal',
          durationMs: aiDurationMs,
          detectorVersion: '3.0',
        },
    aiVideo
      ? {
          id: 'blinking_facial_movement',
          methodName: 'Natural Blinking & Facial Movement Analysis',
          category: 'visual',
          status: aiVideo.facesDetected ? 'completed' : 'not_applicable',
          ran: aiVideo.facesDetected,
          resultSummary: aiVideo.facesDetected
            ? aiVideo.blinkingAndMovementSummary
            : 'Not applicable — no clearly visible human faces present in sampled frames.',
          rawSignalScore: blinkingScore,
          signalPolarity: classifyPolarity(blinkingScore),
          reliability: 'Experimental',
          reliabilityWeight: 0.4,
          calibrationStatus: 'Uncalibrated (Experimental)',
          applicability: 'Evaluates eye gaze, blinking cadence, head motion, and facial micro-expressions',
          evidenceStrength: 'Low',
          evidence: aiVideo.facesDetected
            ? [aiVideo.blinkingAndMovementSummary]
            : ['No human face visible in sampled frames.'],
          limitations: [
            'Short clips or sparse frame intervals may fall between natural human blinks (humans typically blink every 3–6 seconds).',
          ],
          toolUsed: aiVideo.facesDetected
            ? `Gemini Facial Dynamics Review (${aiVideoModelUsed ?? GEMINI_FORENSIC_MODEL})`
            : 'Skipped (no faces)',
          correlationGroup: 'video_gemini_human_face',
          providerGroup: 'gemini_multimodal',
          durationMs: aiDurationMs,
          detectorVersion: '3.0',
        }
      : {
          id: 'blinking_facial_movement',
          methodName: 'Natural Blinking & Facial Movement Analysis',
          category: 'visual',
          status: 'failed',
          ran: false,
          resultSummary: `Failed (recoverable) — Gemini facial movement review unavailable: ${aiVideoError}`,
          rawSignalScore: null,
          signalPolarity: 'neutral',
          reliability: 'Experimental',
          reliabilityWeight: 0.4,
          calibrationStatus: 'Uncalibrated (Experimental)',
          applicability: 'Evaluates eye gaze, blinking cadence, and facial micro-expressions',
          evidenceStrength: 'Low',
          evidence: ['Excluded from scoring due to temporary Gemini API unavailability.'],
          limitations: ['Retry Gemini analysis to inspect facial micro-expressions across preserved frames.'],
          toolUsed: `Gemini Facial Dynamics Review (${GEMINI_FORENSIC_MODEL})`,
          correlationGroup: 'video_gemini_human_face',
          providerGroup: 'gemini_multimodal',
          durationMs: aiDurationMs,
          detectorVersion: '3.0',
        },
    aiVideo
      ? {
          id: 'skin_texture_detail_analysis',
          methodName: 'Skin Texture & Facial Micro-Detail Analysis',
          category: 'visual',
          status: aiVideo.facesDetected ? 'completed' : 'not_applicable',
          ran: aiVideo.facesDetected,
          resultSummary: aiVideo.facesDetected
            ? aiVideo.skinTextureSummary
            : 'Not applicable — no clearly visible human faces present in sampled frames.',
          rawSignalScore: skinScore,
          signalPolarity: classifyPolarity(skinScore),
          reliability: 'Experimental',
          reliabilityWeight: 0.4,
          calibrationStatus: 'Uncalibrated (Experimental)',
          applicability: 'Distinguishes organic skin texture & smartphone denoising from diffusion waxiness or face-swap seams',
          evidenceStrength: 'Low',
          evidence: aiVideo.facesDetected
            ? [aiVideo.skinTextureSummary]
            : ['No human face visible in sampled frames.'],
          limitations: [
            'Smartphone beauty filters, low-light denoising, and social-media video compression soften genuine skin pores without indicating AI generation.',
          ],
          toolUsed: aiVideo.facesDetected
            ? `Gemini Skin & Facial Detail Review (${aiVideoModelUsed ?? GEMINI_FORENSIC_MODEL})`
            : 'Skipped (no faces)',
          correlationGroup: 'video_gemini_human_face',
          providerGroup: 'gemini_multimodal',
          durationMs: aiDurationMs,
          detectorVersion: '3.0',
        }
      : {
          id: 'skin_texture_detail_analysis',
          methodName: 'Skin Texture & Facial Micro-Detail Analysis',
          category: 'visual',
          status: 'failed',
          ran: false,
          resultSummary: `Failed (recoverable) — Gemini skin texture inspection unavailable: ${aiVideoError}`,
          rawSignalScore: null,
          signalPolarity: 'neutral',
          reliability: 'Experimental',
          reliabilityWeight: 0.4,
          calibrationStatus: 'Uncalibrated (Experimental)',
          applicability: 'Skin texture and face-swap boundary inspection',
          evidenceStrength: 'Low',
          evidence: ['Excluded from scoring due to temporary Gemini API unavailability.'],
          limitations: ['Retry Gemini analysis once upstream API load normalizes.'],
          toolUsed: `Gemini Skin & Facial Detail Review (${GEMINI_FORENSIC_MODEL})`,
          correlationGroup: 'video_gemini_human_face',
          providerGroup: 'gemini_multimodal',
          durationMs: aiDurationMs,
          detectorVersion: '3.0',
        },
    {
      id: 'lip_sync_consistency',
      methodName: 'Lip-Sync Consistency Analysis',
      category: 'temporal',
      status:
        hasAudioTrack && (aiVideo ? aiVideo.speechAndVisibleFaceDetected : true)
          ? 'unavailable'
          : 'not_applicable',
      ran: false,
      resultSummary:
        hasAudioTrack && (aiVideo ? aiVideo.speechAndVisibleFaceDetected : true)
          ? `Not performed — dedicated phoneme-to-viseme audio-visual lip-sync alignment model (e.g., SyncNet) is not installed in this runtime.${aiVideo ? ` Visual note: ${aiVideo.lipSyncSummary}` : ''}`
          : 'Not applicable — requires both a speech audio track and clearly visible speaking faces.',
      rawSignalScore: null,
      signalPolarity: 'neutral',
      reliability: 'Moderate',
      reliabilityWeight: 0.55,
      calibrationStatus: 'Uncalibrated (Experimental)',
      applicability: 'Videos with synchronized speech and visible speaking faces',
      evidenceStrength: 'Low',
      evidence: [
        hasAudioTrack
          ? `Audio stream present (${metadata.audioCodec}), but sub-frame viseme synchronization requires a specialized SyncNet model not deployed in this runtime.`
          : 'No audio stream detected in video container.',
      ],
      limitations: [
        'Cannot verify millisecond-level lip synchronization from discrete sampled keyframes alone.',
      ],
      toolUsed: 'Not integrated (SyncNet unavailable)',
      correlationGroup: 'video_lipsync',
      providerGroup: 'unavailable',
      durationMs: 0,
      detectorVersion: '3.0',
    },
    {
      id: 'temporal_consistency_analysis',
      methodName: 'Temporal & Histogram Bhattacharyya Coherence',
      category: 'temporal',
      status: aiVideo ? 'completed' : 'partially_completed',
      ran: true,
      resultSummary: aiVideo
        ? `${aiVideo.temporalSummary}${
            meanHistogramSimilarity !== null
              ? ` (Mean inter-frame Bhattacharyya histogram similarity: ${meanHistogramSimilarity} — contextual metric only).`
              : ''
          }`
        : `Deterministic Bhattacharyya histogram similarity completed locally (mean: ${meanHistogramSimilarity ?? 'N/A'}); Gemini semantic temporal review failed (${aiVideoError}).`,
      rawSignalScore: temporalScore,
      signalPolarity: classifyPolarity(temporalScore),
      reliability: aiVideo ? 'Experimental' : 'Low',
      reliabilityWeight: 0.45,
      calibrationStatus: aiVideo ? 'Uncalibrated (Experimental)' : 'Deterministic Check',
      applicability: 'Cross-frame object permanence, histogram continuity, and motion coherence',
      evidenceStrength: aiVideo && temporalScore !== null && (temporalScore >= 65 || temporalScore <= 30) ? 'Moderate' : 'Low',
      evidence: [
        ...(meanHistogramSimilarity !== null
          ? [
              `Measured mean consecutive Bhattacharyya luminance histogram similarity: ${meanHistogramSimilarity} (high similarity 0.90–0.999 is completely normal in genuine tripod/handheld human videos and is NOT treated as an AI indicator).`,
            ]
          : []),
        `Measured inter-frame pixel luminance deltas: ${
          interFrameDiffs
            .filter((d): d is number => d !== null)
            .map((d) => `${d}%`)
            .join(', ') || 'N/A'
        }.`,
        ...(aiVideo && Array.isArray(aiVideo.temporalEvidence)
          ? aiVideo.temporalEvidence
          : aiVideo
            ? []
            : ['Semantic cross-frame object/identity continuity check did not complete due to Gemini unavailability.']),
      ],
      limitations: [
        'High temporal or histogram stability is normal in genuine camera videos; conversely, fast camera panning or intentional editing can cause sharp jumps without being AI-generated.',
      ],
      toolUsed: aiVideo
        ? `Bhattacharyya Histogram + Gemini Temporal Review (${aiVideoModelUsed ?? GEMINI_FORENSIC_MODEL})`
        : 'TruthLens Bhattacharyya Histogram Analyzer (sharp — Gemini unavailable)',
      correlationGroup: 'video_gemini_motion',
      providerGroup: aiVideo ? 'gemini_multimodal' : 'deterministic_signal',
      durationMs: localDurationMs + (aiVideo ? aiDurationMs : 0),
      detectorVersion: '3.0',
    },
    {
      id: 'frame_interpolation_detection',
      methodName: 'Frame Interpolation & Synthetic Motion Analysis',
      category: 'temporal',
      status: aiVideo ? 'completed' : 'partially_completed',
      ran: true,
      resultSummary: aiVideo
        ? `${aiVideo.syntheticMotionSummary} (${deltaStats.interpolationNote})`
        : `Deterministic motion cadence telemetry computed locally (${deltaStats.interpolationNote}); Gemini synthetic-motion review failed (${aiVideoError}).`,
      rawSignalScore: syntheticMotionScore,
      signalPolarity: classifyPolarity(syntheticMotionScore),
      reliability: aiVideo ? 'Experimental' : 'Low',
      reliabilityWeight: 0.38,
      calibrationStatus: aiVideo ? 'Uncalibrated (Experimental)' : 'Deterministic Check',
      applicability: 'Detects synthetic frame-blending halos, morphing limbs, or floaty AI-video physics',
      evidenceStrength: 'Low',
      evidence: [
        deltaStats.interpolationNote,
        `Declared stream frame rate: ${metadata.frameRate ?? 'Unknown'} fps.`,
        ...(aiVideo && Array.isArray(aiVideo.syntheticMotionEvidence)
          ? aiVideo.syntheticMotionEvidence
          : []),
      ],
      limitations: [
        'Genuine 60fps smartphone recordings and electronic image stabilization (EIS) produce smooth motion naturally; sparse keyframes cannot replace consecutive-frame optical flow.',
      ],
      toolUsed: aiVideo
        ? `TruthLens Delta Cadence + Gemini Motion Review (${aiVideoModelUsed ?? GEMINI_FORENSIC_MODEL})`
        : 'TruthLens Delta Cadence Analyzer (sharp)',
      correlationGroup: 'video_gemini_motion',
      providerGroup: aiVideo ? 'gemini_multimodal' : 'deterministic_signal',
      durationMs: localDurationMs + (aiVideo ? aiDurationMs : 0),
      detectorVersion: '3.0',
    },
    aiVideo
      ? {
          id: 'video_background_consistency',
          methodName: 'Background & Environmental Consistency',
          category: 'visual',
          status: 'completed',
          ran: true,
          resultSummary: aiVideo.backgroundSummary,
          rawSignalScore: backgroundScore,
          signalPolarity: classifyPolarity(backgroundScore),
          reliability: 'Experimental',
          reliabilityWeight: 0.35,
          calibrationStatus: 'Uncalibrated (Experimental)',
          applicability: 'Checks background geometry, signage, architecture, and parallax continuity',
          evidenceStrength: 'Low',
          evidence: Array.isArray(aiVideo.backgroundEvidence) ? aiVideo.backgroundEvidence : [],
          limitations: [
            'A consistent static room, office, or studio background is normal in real human videos and does not indicate AI synthesis.',
          ],
          toolUsed: `Gemini Background Coherence Review (${aiVideoModelUsed ?? GEMINI_FORENSIC_MODEL})`,
          correlationGroup: 'video_gemini_visual',
          providerGroup: 'gemini_multimodal',
          durationMs: aiDurationMs,
          detectorVersion: '3.0',
        }
      : {
          id: 'video_background_consistency',
          methodName: 'Background & Environmental Consistency',
          category: 'visual',
          status: 'failed',
          ran: false,
          resultSummary: `Failed (recoverable) — Gemini background inspection unavailable: ${aiVideoError}`,
          rawSignalScore: null,
          signalPolarity: 'neutral',
          reliability: 'Experimental',
          reliabilityWeight: 0.35,
          calibrationStatus: 'Uncalibrated (Experimental)',
          applicability: 'Background geometry and environmental continuity',
          evidenceStrength: 'Low',
          evidence: ['Excluded from scoring due to temporary Gemini API unavailability.'],
          limitations: ['Retry Gemini analysis to inspect background geometry across preserved frames.'],
          toolUsed: `Gemini Background Coherence Review (${GEMINI_FORENSIC_MODEL})`,
          correlationGroup: 'video_gemini_visual',
          providerGroup: 'gemini_multimodal',
          durationMs: aiDurationMs,
          detectorVersion: '3.0',
        },
    aiVideo
      ? {
          id: 'video_lighting_consistency',
          methodName: 'Cross-Frame Lighting & Shadow Consistency',
          category: 'visual',
          status: 'completed',
          ran: true,
          resultSummary: aiVideo.lightingSummary,
          rawSignalScore: lightingScore,
          signalPolarity: classifyPolarity(lightingScore),
          reliability: 'Experimental',
          reliabilityWeight: 0.35,
          calibrationStatus: 'Uncalibrated (Experimental)',
          applicability: 'Illumination, shadows, and exposure continuity across frames',
          evidenceStrength: 'Low',
          evidence: Array.isArray(aiVideo.lightingEvidence) ? aiVideo.lightingEvidence : [],
          limitations: [
            'Both stable studio/room lighting and dynamic camera auto-exposure shifts occur naturally in genuine human videos.',
          ],
          toolUsed: `Gemini Cross-Frame Visual Review (${aiVideoModelUsed ?? GEMINI_FORENSIC_MODEL})`,
          correlationGroup: 'video_gemini_visual',
          providerGroup: 'gemini_multimodal',
          durationMs: aiDurationMs,
          detectorVersion: '3.0',
        }
      : {
          id: 'video_lighting_consistency',
          methodName: 'Cross-Frame Lighting & Shadow Consistency',
          category: 'visual',
          status: 'failed',
          ran: false,
          resultSummary: `Failed (recoverable) — Gemini cross-frame lighting inspection failed: ${aiVideoError}`,
          rawSignalScore: null,
          signalPolarity: 'neutral',
          reliability: 'Experimental',
          reliabilityWeight: 0.35,
          calibrationStatus: 'Uncalibrated (Experimental)',
          applicability: 'Illumination, shadows, and exposure continuity across frames',
          evidenceStrength: 'Low',
          evidence: ['Lighting consistency check requires multimodal vision review and was excluded from scoring.'],
          limitations: ['Retry Gemini analysis once upstream API load normalizes.'],
          toolUsed: `Gemini Cross-Frame Visual Review (${GEMINI_FORENSIC_MODEL})`,
          correlationGroup: 'video_gemini_visual',
          providerGroup: 'gemini_multimodal',
          durationMs: aiDurationMs,
          detectorVersion: '3.0',
        },
    {
      id: 'video_gop_compression',
      methodName: 'GOP I/P/B Compression & Re-Encode Analysis',
      category: 'signal',
      status: gopInfo.patternSample ? 'completed' : 'unavailable',
      ran: Boolean(gopInfo.patternSample),
      resultSummary: gopInfo.counts
        ? `Sampled initial GOP structure: I=${gopInfo.counts.I}, P=${gopInfo.counts.P}, B=${gopInfo.counts.B} (pattern: ${gopInfo.patternSample}…).${camMeta.socialMediaReencodeLikely ? ' Container pattern is consistent with social-media or editor re-encoding (neutral).' : ''}`
        : 'Unable to extract per-frame picture types from container stream.',
      rawSignalScore: null,
      signalPolarity: 'neutral',
      reliability: 'Low',
      reliabilityWeight: 0.35,
      calibrationStatus: 'Deterministic Check',
      applicability: 'H.264 / HEVC / VP9 Group-of-Pictures cadence and transcoding analysis',
      evidenceStrength: 'Low',
      evidence: gopInfo.counts
        ? [
            `Observed initial picture-type sequence: ${gopInfo.patternSample}.`,
            `Frame type distribution across first ${gopInfo.counts.I + gopInfo.counts.P + gopInfo.counts.B} frames: ${gopInfo.counts.I} I-frame(s), ${gopInfo.counts.P} P-frame(s), ${gopInfo.counts.B} B-frame(s).`,
            ...(camMeta.socialMediaReencodeLikely
              ? ['Social-media / FFmpeg re-encoding detected — compression degrades fine detail on both genuine camera footage and AI clips, so this signal is strictly neutral.']
              : []),
          ]
        : ['FFprobe returned no frame picture-type entries.'],
      limitations: [
        'GOP cadence indicates encoding and re-encoding history (e.g., FFmpeg/platform transcoding), not directly whether source content was AI-generated.',
      ],
      toolUsed: 'FFprobe GOP Frame Inspector',
      correlationGroup: 'metadata_context',
      providerGroup: 'deterministic_signal',
      durationMs: localDurationMs,
      detectorVersion: '3.0',
    },
    {
      id: 'optical_flow_analysis',
      methodName: 'Dense Optical Flow Analysis (Farnebäck / RAFT)',
      category: 'temporal',
      status: 'unavailable',
      ran: false,
      resultSummary:
        'Not performed — dense pixel optical flow (OpenCV Farnebäck / RAFT) is not installed in this Node.js runtime; coarse inter-frame luminance deltas were computed instead.',
      rawSignalScore: null,
      signalPolarity: 'neutral',
      reliability: 'Moderate',
      reliabilityWeight: 0.5,
      calibrationStatus: 'Uncalibrated (Experimental)',
      applicability: 'Consecutive high-fps frame motion vector fields',
      evidenceStrength: 'Low',
      evidence: [
        `Coarse inter-frame pixel luminance deltas across sampled frames: ${
          interFrameDiffs
            .filter((d): d is number => d !== null)
            .map((d) => `${d}%`)
            .join(', ') || 'N/A'
        }.`,
      ],
      limitations: [
        'Requires OpenCV/RAFT dense optical flow on consecutive frames rather than sparse interval samples.',
      ],
      toolUsed: 'Not integrated (Dense Optical Flow unavailable)',
      correlationGroup: 'video_optical_flow',
      providerGroup: 'unavailable',
      durationMs: 0,
      detectorVersion: '3.0',
    },
    {
      id: 'scene_transition_analysis',
      methodName: 'Scene Transition & Cut Analysis',
      category: 'temporal',
      status: 'completed',
      ran: true,
      resultSummary: `Detected ${sceneCuts.length} major luminance/histogram transition(s) across sampled sequence.${aiVideo ? ` ${aiVideo.sceneTransitionSummary}` : ' (Measured deterministically via sharp pixel delta & Bhattacharyya histogram drops.)'}`,
      rawSignalScore: null,
      signalPolarity: 'neutral',
      reliability: 'Moderate',
      reliabilityWeight: 0.5,
      calibrationStatus: 'Deterministic Check',
      applicability: 'Inter-frame luminance delta and Bhattacharyya histogram drops',
      evidenceStrength: 'Low',
      evidence: [
        sceneCuts.length > 0
          ? `Major visual transitions detected around frame(s): ${sceneCuts
              .map((idx) => `#${idx} (${extractedFrames[idx]?.timestampLabel})`)
              .join(', ')}.`
          : 'Continuous single-shot visual progression across sampled intervals (typical of uninterrupted camera recording).',
      ],
      limitations: [
        'Full frame-accurate shot boundary detection (PySceneDetect) requires scanning every decoded frame.',
      ],
      toolUsed: 'TruthLens Inter-Frame Pixel & Histogram Analyzer (sharp)',
      correlationGroup: 'scene_transitions',
      providerGroup: 'deterministic_signal',
      durationMs: localDurationMs,
      detectorVersion: '3.0',
    },
    wmResult.watermarkDetector,
    wmResult.ocrDetector,
    {
      id: 'video_metadata_inspection',
      methodName: 'Camera Recording Characteristics & Container Metadata',
      category: 'metadata',
      status: 'completed',
      ran: true,
      resultSummary: camMeta.encoderMatchesAi
        ? `Container encoder metadata ("${metadata.encoder}") matches a known AI video platform string.`
        : camMeta.cameraHardwareTagDetected
          ? `Native camera/smartphone capture metadata observed (${camMeta.cameraCharacteristics[0]}). Container: ${metadata.containerFormat || 'Unknown'}, ${metadata.videoCodec || 'Unknown'} @ ${metadata.frameRate ?? '?'} fps.${aiVideo?.cameraCharacteristicsSummary ? ` Visual optical note: ${aiVideo.cameraCharacteristicsSummary}` : ''}`
          : `Container: ${metadata.containerFormat || 'Unknown'}, Video: ${metadata.videoCodec || 'Unknown'}, Resolution: ${metadata.width ?? '?'}×${metadata.height ?? '?'} @ ${metadata.frameRate ?? '?'} fps.${camMeta.socialMediaReencodeLikely ? ' Metadata appears stripped/re-encoded (neutral).' : ''}${aiVideo?.cameraCharacteristicsSummary ? ` Visual optical note: ${aiVideo.cameraCharacteristicsSummary}` : ''}`,
      rawSignalScore: camMeta.encoderMatchesAi ? 78 : null,
      signalPolarity: camMeta.encoderMatchesAi
        ? 'ai_indicator'
        : camMeta.cameraHardwareTagDetected
          ? 'natural_capture'
          : 'neutral',
      reliability: camMeta.encoderMatchesAi ? 'Moderate' : 'Low',
      reliabilityWeight: 0.35,
      calibrationStatus: 'Deterministic Check',
      applicability: 'MP4/MOV/WEBM stream headers, camera device tags, and optical capture cues',
      evidenceStrength: camMeta.encoderMatchesAi ? 'Moderate' : 'Low',
      evidence: [
        `Encoder tag: ${metadata.encoder || 'Not present'}.`,
        `Duration: ${metadata.durationSeconds ?? 'Unknown'}s | Bitrate: ${metadata.videoBitrate ? `${Math.round(metadata.videoBitrate / 1000)} kbps` : 'Unknown'}.`,
        `Container tags present: ${Object.keys(metadata.tags ?? {}).length}.`,
        ...camMeta.cameraCharacteristics,
        ...(aiVideo?.cameraCharacteristicsSummary ? [`Visual capture observation: ${aiVideo.cameraCharacteristicsSummary}`] : []),
      ],
      limitations: [
        'Container metadata can be stripped during social-media uploads or copied via re-muxing. Native camera tags are contextual support only, and missing tags are strictly neutral.',
      ],
      toolUsed: 'FFprobe Container & Camera Inspector',
      correlationGroup: 'metadata_context',
      providerGroup: 'deterministic_metadata',
      durationMs: localDurationMs,
      detectorVersion: '3.0',
    },
    {
      id: 'audio_video_consistency',
      methodName: 'Audio-Video Stream Consistency',
      category: 'temporal',
      status: 'completed',
      ran: true,
      resultSummary: hasAudioTrack
        ? `Synchronized container audio stream detected (${metadata.audioCodec}) alongside video stream (${metadata.videoCodec ?? 'unknown'}).`
        : 'Video contains no audio stream (silent video — occurs in both muted camera/B-roll clips and raw AI video exports; strictly neutral).',
      rawSignalScore: null,
      signalPolarity: 'neutral',
      reliability: 'Low',
      reliabilityWeight: 0.3,
      calibrationStatus: 'Deterministic Check',
      applicability: 'Container audio/video stream presence and codec pairing',
      evidenceStrength: 'Low',
      evidence: [
        `Video codec: ${metadata.videoCodec || 'Unknown'} | Audio codec: ${metadata.audioCodec || 'None detected'}.`,
      ],
      limitations: [
        'Silent videos are produced by both real cameras/editing exports and AI video generators; absence of audio is contextual only.',
      ],
      toolUsed: 'FFprobe Stream Analyzer',
      correlationGroup: 'av_stream_context',
      providerGroup: 'deterministic_metadata',
      durationMs: localDurationMs,
      detectorVersion: '3.0',
    },
    aiVideo
      ? {
          id: 'ai_video_classification',
          methodName: 'AI Video Multimodal Classification',
          category: 'ai_reasoning',
          status: 'completed',
          ran: true,
          resultSummary: aiVideo.aiVideoSummary,
          rawSignalScore: aiOverallScore,
          signalPolarity: classifyPolarity(aiOverallScore),
          reliability: 'Experimental',
          reliabilityWeight: 0.55,
          calibrationStatus: 'Uncalibrated (Experimental)',
          applicability: 'Holistic multi-frame synthesis vs. camera-authenticity assessment',
          evidenceStrength:
            aiOverallScore !== null && (aiOverallScore >= 72 || aiOverallScore <= 28)
              ? 'Moderate'
              : 'Low',
          evidence: [
            ...(Array.isArray(aiVideo.aiVideoEvidence) ? aiVideo.aiVideoEvidence : []),
            ...(Array.isArray(aiVideo.naturalCaptureEvidence)
              ? aiVideo.naturalCaptureEvidence.map((e) => `[Natural capture cue] ${e}`)
              : []),
          ],
          limitations: [
            'Evaluated over sampled frames rather than full native frame rate; experimental uncalibrated reasoning signal.',
          ],
          toolUsed: `Gemini Multimodal Video Frame Analysis (${aiVideoModelUsed ?? GEMINI_FORENSIC_MODEL})`,
          correlationGroup: 'video_gemini_visual',
          providerGroup: 'gemini_multimodal',
          durationMs: aiDurationMs,
          detectorVersion: '3.0',
        }
      : {
          id: 'ai_video_classification',
          methodName: 'AI Video Multimodal Classification',
          category: 'ai_reasoning',
          status: 'failed',
          ran: false,
          resultSummary: `Failed (recoverable) — Gemini multimodal video classifier unavailable: ${aiVideoError}`,
          rawSignalScore: null,
          signalPolarity: 'neutral',
          reliability: 'Experimental',
          reliabilityWeight: 0.55,
          calibrationStatus: 'Uncalibrated (Experimental)',
          applicability: 'Holistic multi-frame synthesis assessment',
          evidenceStrength: 'Low',
          evidence: [
            `Upstream error: ${aiVideoError}`,
            'Excluded from evidence aggregation so API unavailability never biases the AI-likelihood score.',
          ],
          limitations: [
            'Retry Gemini Analysis to evaluate the preserved frames without re-running FFmpeg preprocessing.',
          ],
          toolUsed: `Gemini Multimodal Video Frame Analysis (${GEMINI_FORENSIC_MODEL})`,
          correlationGroup: 'video_gemini_visual',
          providerGroup: 'gemini_multimodal',
          durationMs: aiDurationMs,
          detectorVersion: '3.0',
        },
    provenance.c2paDetector,
    provenance.synthIdDetector,
  ];

  const geminiStatus: 'completed' | 'partially_completed' | 'failed' =
    aiVideo && wmResult.geminiSucceeded
      ? 'completed'
      : aiVideo || wmResult.geminiSucceeded
        ? 'partially_completed'
        : 'failed';

  const geminiErrors = [wmResult.geminiError, aiVideoError].filter(Boolean);

  return {
    detectors,
    watermarks: [...wmResult.watermarks, ...provenance.provenanceWatermarks],
    videoFrames,
    videoSamplingStrategy: samplingStrategy,
    videoTelemetry: {
      totalFramesEstimated: totalFramesEst,
      extractedFramesCount: extractedFrames.length,
      skippedFramesEstimated: skippedFramesEst,
      intervalSeconds: intervalSec,
      meanHistogramSimilarity,
      gopPatternSample: gopInfo.patternSample,
      gopCounts: gopInfo.counts,
      frameDeltaVariance: deltaStats.variance,
      cameraCharacteristicsDetected: camMeta.cameraCharacteristics,
      socialMediaReencodeLikely: camMeta.socialMediaReencodeLikely,
      adaptiveSamplingApplied,
      interpolationNote: deltaStats.interpolationNote,
    },
    geminiStatus,
    geminiModelUsed: aiVideoModelUsed ?? wmResult.geminiModelUsed,
    geminiFailureDetail: geminiErrors.length > 0 ? Array.from(new Set(geminiErrors)).join(' | ') : null,
    reusedCachedFrames,
  };
}
