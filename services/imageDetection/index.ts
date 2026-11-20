import { Type, ThinkingLevel } from '@google/genai';
import sharp from 'sharp';
import type {
  DetectorResult,
  ExtractedMetadata,
  ImageVisualMetrics,
  WatermarkFinding,
} from '../../src/types/forensics.ts';
import { MAX_IMAGE_PIXELS } from '../fileValidation.ts';
import {
  GEMINI_FORENSIC_MODEL,
  type GeminiRetryEvent,
  runStructuredGeminiAnalysisWithMeta,
} from '../geminiClient.ts';
import type { ProvenanceInspectionOutput } from '../provenanceVerification/index.ts';
import { runWatermarkDetection } from '../watermarkDetection/index.ts';

interface GeminiImageForensicsResponse {
  aiImageClassificationScore: number;
  aiClassificationSummary: string;
  aiClassificationEvidence: string[];
  texturePatternScore: number;
  texturePatternSummary: string;
  texturePatternEvidence: string[];
  lightingShadowScore: number;
  lightingShadowSummary: string;
  lightingShadowEvidence: string[];
  manipulationCompositingScore: number;
  manipulationSummary: string;
  manipulationEvidence: string[];
  suspiciousRegions: Array<{
    label: string;
    region: string;
    observation: string;
  }>;
  metadataInterpretation: string;
}

const IMAGE_FORENSICS_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    aiImageClassificationScore: {
      type: Type.INTEGER,
      description: '0 to 100 experimental signal indicating likelihood of AI generation based on visual synthesis indicators.',
    },
    aiClassificationSummary: { type: Type.STRING },
    aiClassificationEvidence: { type: Type.ARRAY, items: { type: Type.STRING } },
    texturePatternScore: { type: Type.INTEGER },
    texturePatternSummary: { type: Type.STRING },
    texturePatternEvidence: { type: Type.ARRAY, items: { type: Type.STRING } },
    lightingShadowScore: { type: Type.INTEGER },
    lightingShadowSummary: { type: Type.STRING },
    lightingShadowEvidence: { type: Type.ARRAY, items: { type: Type.STRING } },
    manipulationCompositingScore: { type: Type.INTEGER },
    manipulationSummary: { type: Type.STRING },
    manipulationEvidence: { type: Type.ARRAY, items: { type: Type.STRING } },
    suspiciousRegions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          label: { type: Type.STRING },
          region: { type: Type.STRING },
          observation: { type: Type.STRING },
        },
        required: ['label', 'region', 'observation'],
      },
    },
    metadataInterpretation: { type: Type.STRING },
  },
  required: [
    'aiImageClassificationScore',
    'aiClassificationSummary',
    'aiClassificationEvidence',
    'texturePatternScore',
    'texturePatternSummary',
    'texturePatternEvidence',
    'lightingShadowScore',
    'lightingShadowSummary',
    'lightingShadowEvidence',
    'manipulationCompositingScore',
    'manipulationSummary',
    'manipulationEvidence',
    'suspiciousRegions',
    'metadataInterpretation',
  ],
};

function computeShannonEntropy(histogram: Uint32Array, totalPixels: number): number {
  if (totalPixels === 0) return 0;
  let entropy = 0;
  for (let i = 0; i < 256; i++) {
    const c = histogram[i];
    if (c > 0) {
      const p = c / totalPixels;
      entropy -= p * Math.log2(p);
    }
  }
  return Number(entropy.toFixed(3));
}

async function computePixelForensics(filePath: string): Promise<{
  laplacianVariance: number;
  quadrantNoiseSpread: number;
  noiseResidualIndex: number;
  channelEntropy: { r: number; g: number; b: number };
  elaMeanDiff: number;
  elaMaxDiff: number;
  doubleCompressionDelta: number;
  highFreqEnergyRatio: number;
  edgeDensity: number;
  aspectRatio: string;
}> {
  // Normalize working copy to max 512px for fast, deterministic pixel forensics
  const baseSharp = sharp(filePath, { limitInputPixels: MAX_IMAGE_PIXELS });
  const origMeta = await baseSharp.metadata();
  const origW = origMeta.width ?? 512;
  const origH = origMeta.height ?? 512;

  const { data: rawRgb, info } = await sharp(filePath, { limitInputPixels: MAX_IMAGE_PIXELS })
    .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width;
  const h = info.height;
  const totalPixels = w * h;

  const histR = new Uint32Array(256);
  const histG = new Uint32Array(256);
  const histB = new Uint32Array(256);
  const gray = new Float32Array(totalPixels);

  for (let i = 0; i < totalPixels; i++) {
    const r = rawRgb[i * 3];
    const g = rawRgb[i * 3 + 1];
    const b = rawRgb[i * 3 + 2];
    histR[r]++;
    histG[g]++;
    histB[b]++;
    gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }

  const channelEntropy = {
    r: computeShannonEntropy(histR, totalPixels),
    g: computeShannonEntropy(histG, totalPixels),
    b: computeShannonEntropy(histB, totalPixels),
  };

  // Compute 3x3 Laplacian high-pass noise residual + Sobel edge energy + quadrant noise uniformity
  let lapSum = 0;
  let lapSqSum = 0;
  let lapCount = 0;
  let highFreqEnergy = 0;
  let totalSignalEnergy = 0;
  let edgePixels = 0;

  const quadSums = [0, 0, 0, 0];
  const quadSqSums = [0, 0, 0, 0];
  const quadCounts = [0, 0, 0, 0];
  const halfW = Math.floor(w / 2);
  const halfH = Math.floor(h / 2);

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = y * w + x;
      const center = gray[idx];
      const lap =
        gray[idx - w] + gray[idx + w] + gray[idx - 1] + gray[idx + 1] - 4 * center;
      lapSum += lap;
      lapSqSum += lap * lap;
      lapCount++;

      const q = (y >= halfH ? 2 : 0) + (x >= halfW ? 1 : 0);
      quadSums[q] += lap;
      quadSqSums[q] += lap * lap;
      quadCounts[q]++;

      // Simple Sobel gradient magnitude
      const gx =
        -gray[idx - w - 1] +
        gray[idx - w + 1] -
        2 * gray[idx - 1] +
        2 * gray[idx + 1] -
        gray[idx + w - 1] +
        gray[idx + w + 1];
      const gy =
        -gray[idx - w - 1] -
        2 * gray[idx - w] -
        gray[idx - w + 1] +
        gray[idx + w - 1] +
        2 * gray[idx + w] +
        gray[idx + w + 1];
      const gradMag = Math.sqrt(gx * gx + gy * gy);
      if (gradMag > 60) edgePixels++;

      highFreqEnergy += Math.abs(lap);
      totalSignalEnergy += center + 1;
    }
  }

  const lapMean = lapCount > 0 ? lapSum / lapCount : 0;
  const laplacianVariance =
    lapCount > 0 ? Number((lapSqSum / lapCount - lapMean * lapMean).toFixed(2)) : 0;

  const quadVars = [0, 1, 2, 3].map((q) => {
    const c = quadCounts[q];
    if (c === 0) return 0;
    const m = quadSums[q] / c;
    return Math.max(0, quadSqSums[q] / c - m * m);
  });
  const maxQ = Math.max(...quadVars);
  const minQ = Math.min(...quadVars);
  const quadrantNoiseSpread =
    maxQ > 0 ? Number(((maxQ - minQ) / maxQ).toFixed(3)) : 0;

  // Error Level Analysis (Q90) + Double-Compression Quantization Delta (Q95 vs Q75)
  const [recomp90, recomp75] = await Promise.all([
    sharp(rawRgb, { raw: { width: w, height: h, channels: 3 } })
      .jpeg({ quality: 90 })
      .toBuffer(),
    sharp(rawRgb, { raw: { width: w, height: h, channels: 3 } })
      .jpeg({ quality: 75 })
      .toBuffer(),
  ]);

  const [{ data: recompRgb }, { data: recomp75Rgb }] = await Promise.all([
    sharp(recomp90).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(recomp75).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);

  let elaSum = 0;
  let elaMax = 0;
  let q75Sum = 0;
  const len = Math.min(rawRgb.length, recompRgb.length, recomp75Rgb.length);
  for (let i = 0; i < len; i++) {
    const diff = Math.abs(rawRgb[i] - recompRgb[i]);
    elaSum += diff;
    if (diff > elaMax) elaMax = diff;
    q75Sum += Math.abs(rawRgb[i] - recomp75Rgb[i]);
  }
  const elaMeanDiff = len > 0 ? Number((elaSum / len).toFixed(3)) : 0;
  const q75MeanDiff = len > 0 ? q75Sum / len : 0;
  const doubleCompressionDelta = Number(Math.abs(q75MeanDiff - elaMeanDiff).toFixed(3));
  const highFreqEnergyRatio =
    totalSignalEnergy > 0 ? Number((highFreqEnergy / totalSignalEnergy).toFixed(4)) : 0;
  const edgeDensity = lapCount > 0 ? Number((edgePixels / lapCount).toFixed(4)) : 0;
  const noiseResidualIndex = Number(Math.min(100, Math.sqrt(Math.max(0, laplacianVariance))).toFixed(2));

  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const d = gcd(origW, origH) || 1;
  const aspectRatio = `${Math.round(origW / d)}:${Math.round(origH / d)} (${origW}×${origH})`;

  return {
    laplacianVariance,
    quadrantNoiseSpread,
    noiseResidualIndex,
    channelEntropy,
    elaMeanDiff,
    elaMaxDiff: elaMax,
    doubleCompressionDelta,
    highFreqEnergyRatio,
    edgeDensity,
    aspectRatio,
  };
}

export interface ImagePipelineOutput {
  detectors: DetectorResult[];
  watermarks: WatermarkFinding[];
  imageVisualMetrics: ImageVisualMetrics;
  geminiStatus: 'completed' | 'partially_completed' | 'failed';
  geminiModelUsed: string | null;
  geminiFailureDetail: string | null;
}

export async function runImageDetectionPipeline(options: {
  analysisId: string;
  filePath: string;
  cropsOutputDir: string;
  metadata: ExtractedMetadata;
  provenance: ProvenanceInspectionOutput;
  onStageProgress?: (
    stageId: 'forensic_analysis' | 'ai_assessment',
    detail: string,
    statusOverride?: 'running' | 'retrying',
  ) => void;
}): Promise<ImagePipelineOutput> {
  const { analysisId, filePath, cropsOutputDir, metadata, provenance, onStageProgress } = options;

  onStageProgress?.(
    'forensic_analysis',
    'Computing pixel-level entropy, Laplacian noise residuals, multi-quality ELA, and frequency ratios via sharp.',
  );
  const tPixel = Date.now();
  const pixelStats = await computePixelForensics(filePath);
  const pixelDurationMs = Date.now() - tPixel;

  onStageProgress?.(
    'forensic_analysis',
    'Running dedicated visible watermark, logo, and top/bottom edge-strip OCR inspection.',
  );
  const wmResult = await runWatermarkDetection({
    analysisId,
    mediaType: 'image',
    frames: [{ frameIndex: 0, timestampLabel: 'Still image', filePath }],
    cropsOutputDir,
    onRetry: (evt: GeminiRetryEvent) => {
      onStageProgress?.(
        'forensic_analysis',
        `Watermark OCR retrying (${evt.attempt}/${evt.totalAttempts} → ${evt.nextModel} in ${(evt.delayMs / 1000).toFixed(1)}s): ${evt.reason}`,
        'retrying',
      );
    },
  });

  onStageProgress?.(
    'ai_assessment',
    'Running Gemini multimodal visual forensics for synthesis, texture, lighting, and compositing inspection.',
  );
  const tAi = Date.now();
  const resizedForGemini = await sharp(filePath, { limitInputPixels: MAX_IMAGE_PIXELS })
    .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 84 })
    .toBuffer();

  const geminiPrompt = [
    'Analyse this uploaded image for signs of AI generation, AI editing, or digital compositing/manipulation.',
    'Measured deterministic pixel-forensic telemetry (do NOT alter these numbers):',
    `- Dimensions: ${metadata.width ?? 'unknown'}x${metadata.height ?? 'unknown'} (${pixelStats.aspectRatio})`,
    `- RGB Shannon Entropy: R=${pixelStats.channelEntropy.r}, G=${pixelStats.channelEntropy.g}, B=${pixelStats.channelEntropy.b}`,
    `- Laplacian Noise Variance: ${pixelStats.laplacianVariance} (Quadrant Noise Spread: ${pixelStats.quadrantNoiseSpread})`,
    `- Error Level Analysis (JPEG Q90 mean abs diff): ${pixelStats.elaMeanDiff}, max diff: ${pixelStats.elaMaxDiff}, Q90/Q75 delta: ${pixelStats.doubleCompressionDelta}`,
    `- High-Frequency Energy Ratio: ${pixelStats.highFreqEnergyRatio}, Edge Density: ${pixelStats.edgeDensity}`,
    `- EXIF Metadata present: ${metadata.metadataPresent} | Camera: ${metadata.cameraMake ?? 'None'} ${metadata.cameraModel ?? ''} | Software: ${metadata.software ?? 'None'}`,
    `- C2PA Status: ${metadata.c2paStatus}`,
    `- Dedicated Watermark Scan Result: ${wmResult.watermarkDetector.resultSummary}`,
    '',
    'CRITICAL GUIDELINES:',
    '- Hands, fingers, or eye anomalies alone NEVER prove AI generation; corroborate with broader lighting, texture, and physical coherence.',
    '- Provide calibrated, conservative experimental scores (0-100 where <35 suggests likely photographic capture, 40-60 is inconclusive, >65 indicates visual AI synthesis or manipulation indicators).',
    '- Never claim 100% certainty. List only concrete regions/observations directly visible in this image.',
  ].join('\n');

  let aiVisual: GeminiImageForensicsResponse | null = null;
  let aiModelUsed: string | null = null;
  let aiVisualError: string | null = null;

  try {
    const res = await runStructuredGeminiAnalysisWithMeta<GeminiImageForensicsResponse>({
      parts: [
        {
          inlineData: {
            mimeType: 'image/jpeg',
            data: resizedForGemini.toString('base64'),
          },
        },
        { text: geminiPrompt },
      ],
      responseSchema: IMAGE_FORENSICS_SCHEMA,
      thinkingLevel: ThinkingLevel.LOW,
      timeoutMs: 28_000,
      onRetry: (evt: GeminiRetryEvent) => {
        onStageProgress?.(
          'ai_assessment',
          `Gemini visual review retrying (${evt.attempt}/${evt.totalAttempts} → ${evt.nextModel} in ${(evt.delayMs / 1000).toFixed(1)}s): ${evt.reason}`,
          'retrying',
        );
      },
    });
    aiVisual = res.data;
    aiModelUsed = res.modelUsed;
  } catch (err) {
    aiVisualError =
      err instanceof Error ? err.message : 'Gemini visual forensic inspection failed unexpectedly.';
  }
  const aiDurationMs = Date.now() - tAi;

  const avgEntropy = Number(
    ((pixelStats.channelEntropy.r + pixelStats.channelEntropy.g + pixelStats.channelEntropy.b) / 3).toFixed(3),
  );
  const pixelSignalAnomaly =
    avgEntropy < 5.5
      ? 'Unusually low channel entropy (smooth tonal distribution; common in illustrations, screenshots, or synthetic renders).'
      : 'Channel entropy sits within typical photographic and high-detail digital image ranges.';

  const elaSignalScore =
    pixelStats.elaMeanDiff > 7.5 && pixelStats.quadrantNoiseSpread > 0.72
      ? 62
      : pixelStats.elaMeanDiff < 0.8 && metadata.detectedMime === 'image/png'
        ? 52
        : null;

  const metadataHasCamera = Boolean(metadata.cameraMake || metadata.cameraModel);
  const aiSoftwarePattern =
    /midjourney|dall-?e|stable diffusion|comfyui|automatic1111|firefly|imagen|veo|sora|flux|novelai/i;
  const softwareMatchesAi = Boolean(metadata.software && aiSoftwarePattern.test(metadata.software));
  const metadataSignalScore = softwareMatchesAi ? 76 : metadataHasCamera ? 28 : null;

  const detectors: DetectorResult[] = [
    aiVisual
      ? {
          id: 'ai_image_classification',
          methodName: 'AI-Generated Image Classification',
          category: 'ai_reasoning',
          status: 'completed',
          ran: true,
          resultSummary: aiVisual.aiClassificationSummary,
          rawSignalScore: Math.max(5, Math.min(95, aiVisual.aiImageClassificationScore)),
          reliability: 'Experimental',
          reliabilityWeight: 0.48,
          calibrationStatus: 'Uncalibrated (Experimental)',
          applicability: 'Full-frame multimodal visual inspection',
          evidenceStrength:
            aiVisual.aiImageClassificationScore >= 72 || aiVisual.aiImageClassificationScore <= 28
              ? 'Moderate'
              : 'Low',
          evidence: aiVisual.aiClassificationEvidence,
          limitations: [
            'Multimodal LLM inspection is not a calibrated trained binary classifier; anatomical details (hands/eyes) alone never establish AI generation.',
          ],
          toolUsed: `Gemini Multimodal Visual Forensics (${aiModelUsed ?? GEMINI_FORENSIC_MODEL})`,
          correlationGroup: 'visual_ai_assessment',
          durationMs: aiDurationMs,
          detectorVersion: '2.1',
        }
      : {
          id: 'ai_image_classification',
          methodName: 'AI-Generated Image Classification',
          category: 'ai_reasoning',
          status: 'failed',
          ran: false,
          resultSummary: `Failed (recoverable) — Gemini visual classifier unavailable: ${aiVisualError}`,
          rawSignalScore: null,
          reliability: 'Experimental',
          reliabilityWeight: 0.48,
          calibrationStatus: 'Uncalibrated (Experimental)',
          applicability: 'Full-frame multimodal visual inspection',
          evidenceStrength: 'Low',
          evidence: [`Upstream error: ${aiVisualError}`],
          limitations: ['Excluded from scoring; API failures are never treated as evidence of AI generation.'],
          toolUsed: `Gemini Multimodal Visual Forensics (${GEMINI_FORENSIC_MODEL})`,
          correlationGroup: 'visual_ai_assessment',
          durationMs: aiDurationMs,
          detectorVersion: '2.1',
        },
    {
      id: 'pixel_level_forensics',
      methodName: 'Pixel-Level Forensic Analysis',
      category: 'signal',
      status: 'completed',
      ran: true,
      resultSummary: `RGB Shannon entropy R=${pixelStats.channelEntropy.r}, G=${pixelStats.channelEntropy.g}, B=${pixelStats.channelEntropy.b} (mean ${avgEntropy} bits/channel). ${pixelSignalAnomaly}`,
      rawSignalScore: null,
      reliability: 'Low',
      reliabilityWeight: 0.3,
      calibrationStatus: 'Deterministic Check',
      applicability: 'Raw decoded RGB pixel matrix',
      evidenceStrength: 'Low',
      evidence: [
        `Decoded normalized working matrix; measured RGB Shannon entropy (${pixelStats.channelEntropy.r} / ${pixelStats.channelEntropy.g} / ${pixelStats.channelEntropy.b}).`,
        `Measured edge density: ${(pixelStats.edgeDensity * 100).toFixed(1)}% of interior pixels exceed Sobel gradient threshold.`,
      ],
      limitations: [
        'Basic pixel statistics alone cannot reliably distinguish modern AI-generated images from authentic photographs.',
      ],
      toolUsed: 'sharp Raw RGBA Pixel Analyzer',
      correlationGroup: 'pixel_signal_metrics',
      durationMs: pixelDurationMs,
      detectorVersion: '2.0',
    },
    {
      id: 'noise_residual_analysis',
      methodName: 'Noise Residual & Resampling / Double-JPEG Analysis',
      category: 'signal',
      status: 'completed',
      ran: true,
      resultSummary: `Laplacian noise variance ${pixelStats.laplacianVariance}; cross-quadrant spread ${(pixelStats.quadrantNoiseSpread * 100).toFixed(1)}%; ELA Q90 mean ${pixelStats.elaMeanDiff} (Q90/Q75 delta ${pixelStats.doubleCompressionDelta}).`,
      rawSignalScore: elaSignalScore,
      reliability: 'Low',
      reliabilityWeight: 0.4,
      calibrationStatus: 'Uncalibrated (Experimental)',
      applicability: 'High-pass 3×3 Laplacian residual and multi-quality JPEG quantization delta',
      evidenceStrength: 'Low',
      evidence: [
        `Global Laplacian residual variance: ${pixelStats.laplacianVariance} (index ${pixelStats.noiseResidualIndex}).`,
        `Spatial quadrant noise spread ratio: ${(pixelStats.quadrantNoiseSpread * 100).toFixed(1)}%.`,
        `Multi-quality recompression delta (Q90 mean ${pixelStats.elaMeanDiff}, peak ${pixelStats.elaMaxDiff}, Q90/Q75 delta ${pixelStats.doubleCompressionDelta}).`,
      ],
      limitations: [
        'Camera denoising, shallow depth-of-field, and platform re-encoding alter noise residuals and quantization curves substantially.',
      ],
      toolUsed: 'TruthLens Laplacian & Multi-Quality ELA Engine (sharp)',
      correlationGroup: 'pixel_signal_metrics',
      durationMs: pixelDurationMs,
      detectorVersion: '2.0',
    },
    {
      id: 'frequency_domain_analysis',
      methodName: 'Frequency-Domain & High-Frequency Energy Analysis',
      category: 'signal',
      status: 'partially_implemented',
      ran: true,
      resultSummary: `Spatial high-pass residual energy ratio measured at ${pixelStats.highFreqEnergyRatio} (edge density ${(pixelStats.edgeDensity * 100).toFixed(1)}%). Full 2D FFT spectral classifier not installed.`,
      rawSignalScore: null,
      reliability: 'Low',
      reliabilityWeight: 0.45,
      calibrationStatus: 'Uncalibrated (Experimental)',
      applicability: 'Spatial high-pass energy approximation',
      evidenceStrength: 'Low',
      evidence: [
        `High-frequency-to-luminance energy ratio: ${pixelStats.highFreqEnergyRatio}.`,
        'Marked PARTIALLY_IMPLEMENTED because a dedicated 2D FFT azimuthal power-spectrum classifier requires calibrated spectral training weights not deployed in this runtime.',
      ],
      limitations: [
        'Resizing, sharpening filters, and JPEG/WEBP compression heavily mask high-frequency synthesis signatures.',
      ],
      toolUsed: 'TruthLens Spatial High-Pass Estimator',
      correlationGroup: 'pixel_signal_metrics',
      durationMs: pixelDurationMs,
      detectorVersion: '2.0',
    },
    {
      id: 'prnu_sensor_fingerprint',
      methodName: 'PRNU Camera Sensor Fingerprinting',
      category: 'signal',
      status: 'unavailable',
      ran: false,
      resultSummary:
        'Not performed — PRNU sensor noise correlation requires reference images captured by the claimed source camera.',
      rawSignalScore: null,
      reliability: 'Moderate',
      reliabilityWeight: 0.6,
      calibrationStatus: 'Deterministic Check',
      applicability: 'Requires >=20 flat-field reference photos from the alleged camera sensor',
      evidenceStrength: 'Low',
      evidence: ['No reference camera sensor fingerprint corpus was supplied for comparison.'],
      limitations: ['Single-image PRNU cannot verify camera authenticity without reference capture baselines.'],
      toolUsed: 'Unavailable (requires camera reference set)',
      correlationGroup: 'pixel_signal_metrics',
      durationMs: 0,
      detectorVersion: '2.0',
    },
    {
      id: 'copy_move_sift_ransac',
      methodName: 'Copy-Move Forgery Detection (SIFT + RANSAC)',
      category: 'visual',
      status: 'unavailable',
      ran: false,
      resultSummary:
        'Not performed — geometric SIFT keypoint matching + RANSAC bounding-box verification requires native OpenCV bindings not installed in this runtime.',
      rawSignalScore: null,
      reliability: 'Moderate',
      reliabilityWeight: 0.55,
      calibrationStatus: 'Deterministic Check',
      applicability: 'Cloned region detection in edited photographs',
      evidenceStrength: 'Low',
      evidence: ['OpenCV SIFT/RANSAC native module is not installed in this Node.js environment.'],
      limitations: ['Visual compositing checks are performed separately via ELA and multimodal inspection.'],
      toolUsed: 'Not integrated (OpenCV SIFT unavailable)',
      correlationGroup: 'compositing_manipulation',
      durationMs: 0,
      detectorVersion: '2.0',
    },
    aiVisual
      ? {
          id: 'texture_pattern_analysis',
          methodName: 'Texture & Micro-Pattern Inspection',
          category: 'visual',
          status: 'completed',
          ran: true,
          resultSummary: aiVisual.texturePatternSummary,
          rawSignalScore: Math.max(5, Math.min(95, aiVisual.texturePatternScore)),
          reliability: 'Experimental',
          reliabilityWeight: 0.45,
          calibrationStatus: 'Uncalibrated (Experimental)',
          applicability: 'Surface micro-textures, foliage, fabrics, skin, and repeating structures',
          evidenceStrength: 'Moderate',
          evidence: aiVisual.texturePatternEvidence,
          limitations: [
            'Modern photographic noise reduction and HDR merging can mimic synthetic smoothness.',
          ],
          toolUsed: `Gemini Multimodal Inspection (${aiModelUsed ?? GEMINI_FORENSIC_MODEL})`,
          correlationGroup: 'visual_ai_assessment',
          durationMs: aiDurationMs,
          detectorVersion: '2.1',
        }
      : {
          id: 'texture_pattern_analysis',
          methodName: 'Texture & Micro-Pattern Inspection',
          category: 'visual',
          status: 'failed',
          ran: false,
          resultSummary: `Failed (recoverable) — Gemini texture inspection unavailable: ${aiVisualError}`,
          rawSignalScore: null,
          reliability: 'Experimental',
          reliabilityWeight: 0.45,
          calibrationStatus: 'Uncalibrated (Experimental)',
          applicability: 'Surface micro-textures, foliage, fabrics, skin, and repeating structures',
          evidenceStrength: 'Low',
          evidence: ['Excluded from scoring; retry Gemini analysis when available.'],
          limitations: ['Upstream Gemini service unavailable.'],
          toolUsed: `Gemini Multimodal Inspection (${GEMINI_FORENSIC_MODEL})`,
          correlationGroup: 'visual_ai_assessment',
          durationMs: aiDurationMs,
          detectorVersion: '2.1',
        },
    aiVisual
      ? {
          id: 'lighting_shadow_inspection',
          methodName: 'Lighting, Reflection & Shadow Consistency',
          category: 'visual',
          status: 'completed',
          ran: true,
          resultSummary: aiVisual.lightingShadowSummary,
          rawSignalScore: Math.max(5, Math.min(95, aiVisual.lightingShadowScore)),
          reliability: 'Experimental',
          reliabilityWeight: 0.45,
          calibrationStatus: 'Uncalibrated (Experimental)',
          applicability: 'Light directionality, cast shadows, specular highlights, and reflections',
          evidenceStrength: 'Moderate',
          evidence: aiVisual.lightingShadowEvidence,
          limitations: [
            'Complex multi-source studio lighting or overcast diffused light can produce subtle shadow geometries.',
          ],
          toolUsed: `Gemini Multimodal Inspection (${aiModelUsed ?? GEMINI_FORENSIC_MODEL})`,
          correlationGroup: 'visual_physics_check',
          durationMs: aiDurationMs,
          detectorVersion: '2.1',
        }
      : {
          id: 'lighting_shadow_inspection',
          methodName: 'Lighting, Reflection & Shadow Consistency',
          category: 'visual',
          status: 'failed',
          ran: false,
          resultSummary: `Failed (recoverable) — Gemini lighting inspection unavailable: ${aiVisualError}`,
          rawSignalScore: null,
          reliability: 'Experimental',
          reliabilityWeight: 0.45,
          calibrationStatus: 'Uncalibrated (Experimental)',
          applicability: 'Light directionality, cast shadows, specular highlights, and reflections',
          evidenceStrength: 'Low',
          evidence: ['Excluded from scoring; retry Gemini analysis when available.'],
          limitations: ['Upstream Gemini service unavailable.'],
          toolUsed: `Gemini Multimodal Inspection (${GEMINI_FORENSIC_MODEL})`,
          correlationGroup: 'visual_physics_check',
          durationMs: aiDurationMs,
          detectorVersion: '2.1',
        },
    {
      id: 'metadata_extraction_check',
      methodName: 'Image Metadata & EXIF Inspection',
      category: 'metadata',
      status: 'completed',
      ran: true,
      resultSummary: softwareMatchesAi
        ? `Software tag "${metadata.software}" references an AI generation/editing tool.`
        : metadataHasCamera
          ? `Camera EXIF present (${metadata.cameraMake ?? ''} ${metadata.cameraModel ?? ''}).${aiVisual ? ` ${aiVisual.metadataInterpretation}` : ''}`
          : `No camera EXIF hardware identifiers found.${aiVisual ? ` ${aiVisual.metadataInterpretation}` : ''}`,
      rawSignalScore: metadataSignalScore,
      reliability: softwareMatchesAi ? 'Moderate' : 'Low',
      reliabilityWeight: 0.3,
      calibrationStatus: 'Deterministic Check',
      applicability: 'EXIF, XMP, IPTC, ICC, and container tags',
      evidenceStrength: softwareMatchesAi ? 'Moderate' : 'Low',
      evidence: [
        `Metadata present: ${metadata.metadataPresent ? 'Yes' : 'No'} (${metadata.embeddedMetadataKeys?.length ?? 0} parsed EXIF/XMP fields).`,
        `Camera Make/Model: ${metadata.cameraMake || 'Not present'} / ${metadata.cameraModel || 'Not present'}.`,
        `Software tag: ${metadata.software || 'Not present'}.`,
        `ICC Profile: ${metadata.iccProfile || 'Not present'}.`,
      ],
      limitations: [
        'Metadata can be freely edited, stripped by social media/messaging platforms, or forged.',
        'Missing metadata never proves AI generation.',
      ],
      toolUsed: 'exifr + sharp Metadata Parser',
      correlationGroup: 'metadata_context',
      durationMs: pixelDurationMs,
      detectorVersion: '2.1',
    },
    wmResult.watermarkDetector,
    wmResult.ocrDetector,
    aiVisual
      ? {
          id: 'image_manipulation_compositing',
          methodName: 'Manipulation, Boundary & Compositing Indicators',
          category: 'visual',
          status: 'completed',
          ran: true,
          resultSummary: aiVisual.manipulationSummary,
          rawSignalScore: Math.max(5, Math.min(95, aiVisual.manipulationCompositingScore)),
          reliability: 'Experimental',
          reliabilityWeight: 0.48,
          calibrationStatus: 'Uncalibrated (Experimental)',
          applicability: 'Boundary blending, splicing, and ELA consistency',
          evidenceStrength: 'Moderate',
          evidence: aiVisual.manipulationEvidence,
          limitations: [
            'Subtle retouching or global color grading may not leave visible compositing seams.',
          ],
          toolUsed: `ELA + Gemini Multimodal Inspection (${aiModelUsed ?? GEMINI_FORENSIC_MODEL})`,
          correlationGroup: 'compositing_manipulation',
          durationMs: aiDurationMs,
          detectorVersion: '2.1',
        }
      : {
          id: 'image_manipulation_compositing',
          methodName: 'Manipulation, Boundary & Compositing Indicators',
          category: 'visual',
          status: 'failed',
          ran: false,
          resultSummary: `Failed (recoverable) — Gemini visual compositing review unavailable: ${aiVisualError}`,
          rawSignalScore: null,
          reliability: 'Experimental',
          reliabilityWeight: 0.48,
          calibrationStatus: 'Uncalibrated (Experimental)',
          applicability: 'Boundary blending, splicing, and ELA consistency',
          evidenceStrength: 'Low',
          evidence: ['Deterministic ELA/double-JPEG measurements completed separately; visual compositing review excluded from scoring.'],
          limitations: ['Retry Gemini analysis once upstream API load normalizes.'],
          toolUsed: `ELA + Gemini Multimodal Inspection (${GEMINI_FORENSIC_MODEL})`,
          correlationGroup: 'compositing_manipulation',
          durationMs: aiDurationMs,
          detectorVersion: '2.1',
        },
    provenance.c2paDetector,
    provenance.synthIdDetector,
  ];

  const geminiStatus: 'completed' | 'partially_completed' | 'failed' =
    aiVisual && wmResult.geminiSucceeded
      ? 'completed'
      : aiVisual || wmResult.geminiSucceeded
        ? 'partially_completed'
        : 'failed';
  const geminiErrors = [wmResult.geminiError, aiVisualError].filter(Boolean);

  return {
    detectors,
    watermarks: [...wmResult.watermarks, ...provenance.provenanceWatermarks],
    imageVisualMetrics: {
      ...pixelStats,
      ocrExtractedText: wmResult.ocrTexts,
      suspiciousRegions: aiVisual?.suspiciousRegions ?? [],
    },
    geminiStatus,
    geminiModelUsed: aiModelUsed ?? wmResult.geminiModelUsed,
    geminiFailureDetail: geminiErrors.length > 0 ? Array.from(new Set(geminiErrors)).join(' | ') : null,
  };
}
