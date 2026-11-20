import fs from 'node:fs/promises';
import path from 'node:path';
import { Type, ThinkingLevel } from '@google/genai';
import sharp from 'sharp';
import type { DetectorResult, MediaType, WatermarkFinding } from '../../src/types/forensics.ts';
import { MAX_IMAGE_PIXELS } from '../fileValidation.ts';
import {
  type ForensicContentPart,
  GEMINI_FORENSIC_MODEL,
  type GeminiRetryEvent,
  runStructuredGeminiAnalysisWithMeta,
} from '../geminiClient.ts';

interface GeminiWatermarkItem {
  detected: boolean;
  type: 'visible_text' | 'visible_logo';
  recognizedTextOrLogo: string;
  positionInFrame: string;
  frameIndices: number[];
  recognitionConfidence: 'High' | 'Moderate' | 'Low';
  possiblePlatform: string;
  evidenceNote: string;
}

interface GeminiWatermarkResponse {
  visibleWatermarkFound: boolean;
  ocrTextsFound: string[];
  findings: GeminiWatermarkItem[];
  persistenceSummary: string;
  overallAssessment: string;
}

const WATERMARK_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    visibleWatermarkFound: { type: Type.BOOLEAN },
    ocrTextsFound: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Literal visible text strings read via OCR anywhere in the image or video frames.',
    },
    findings: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          detected: { type: Type.BOOLEAN },
          type: { type: Type.STRING, description: 'Either visible_text or visible_logo' },
          recognizedTextOrLogo: { type: Type.STRING },
          positionInFrame: {
            type: Type.STRING,
            description:
              'Exact spatial position such as bottom-right corner, bottom-left corner, top-right corner, top-left corner, bottom-center',
          },
          frameIndices: {
            type: Type.ARRAY,
            items: { type: Type.INTEGER },
            description: '0-based frame indices where this watermark appeared',
          },
          recognitionConfidence: { type: Type.STRING, description: 'High, Moderate, or Low' },
          possiblePlatform: {
            type: Type.STRING,
            description:
              'Possible platform association such as Google Veo, OpenAI Sora, Runway, Kling, Pika, Luma, Hailuo, Midjourney, DALL-E, or Unknown',
          },
          evidenceNote: { type: Type.STRING },
        },
        required: [
          'detected',
          'type',
          'recognizedTextOrLogo',
          'positionInFrame',
          'frameIndices',
          'recognitionConfidence',
          'possiblePlatform',
          'evidenceNote',
        ],
      },
    },
    persistenceSummary: { type: Type.STRING },
    overallAssessment: { type: Type.STRING },
  },
  required: [
    'visibleWatermarkFound',
    'ocrTextsFound',
    'findings',
    'persistenceSummary',
    'overallAssessment',
  ],
};

export interface WatermarkDetectionInputFrame {
  frameIndex: number;
  timestampLabel: string;
  filePath: string;
}

export interface WatermarkDetectionOutput {
  watermarks: WatermarkFinding[];
  ocrTexts: string[];
  watermarkDetector: DetectorResult;
  ocrDetector: DetectorResult;
  perFrameWatermarkMap: Map<number, string>;
  geminiSucceeded: boolean;
  geminiModelUsed: string | null;
  geminiError: string | null;
}

async function createEdgeStripBuffer(
  filePath: string,
  edge: 'top' | 'bottom',
): Promise<Buffer | null> {
  try {
    const img = sharp(filePath, { limitInputPixels: MAX_IMAGE_PIXELS });
    const meta = await img.metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    if (w < 120 || h < 120) return null;

    const stripHeight = Math.max(44, Math.round(h * (edge === 'bottom' ? 0.22 : 0.18)));
    const top = edge === 'bottom' ? Math.max(0, h - stripHeight) : 0;
    return await sharp(filePath, { limitInputPixels: MAX_IMAGE_PIXELS })
      .extract({ left: 0, top, width: w, height: stripHeight })
      .resize({ width: Math.min(w, 960), withoutEnlargement: true })
      .jpeg({ quality: 84 })
      .toBuffer();
  } catch {
    return null;
  }
}

async function saveEvidenceCrop(
  framePath: string,
  positionInFrame: string,
  outputDir: string,
  fileName: string,
): Promise<boolean> {
  try {
    await fs.mkdir(outputDir, { recursive: true });
    const meta = await sharp(framePath, { limitInputPixels: MAX_IMAGE_PIXELS }).metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    if (w < 120 || h < 120) return false;

    const pos = positionInFrame.toLowerCase();
    const cropW = Math.min(w, Math.max(120, Math.round(w * 0.42)));
    const cropH = Math.min(h, Math.max(80, Math.round(h * 0.28)));

    let left = Math.round((w - cropW) / 2);
    let top = Math.max(0, h - cropH);

    if (pos.includes('right')) left = Math.max(0, w - cropW);
    else if (pos.includes('left')) left = 0;

    if (pos.includes('top')) top = 0;
    else if (pos.includes('center') && !pos.includes('bottom')) top = Math.round((h - cropH) / 2);

    await sharp(framePath, { limitInputPixels: MAX_IMAGE_PIXELS })
      .extract({ left, top, width: cropW, height: cropH })
      .resize({ width: 520, withoutEnlargement: true })
      .jpeg({ quality: 90 })
      .toFile(path.join(outputDir, fileName));
    return true;
  } catch {
    return false;
  }
}

export async function runWatermarkDetection(options: {
  analysisId: string;
  mediaType: MediaType;
  frames: WatermarkDetectionInputFrame[];
  cropsOutputDir?: string;
  onRetry?: (event: GeminiRetryEvent) => void;
}): Promise<WatermarkDetectionOutput> {
  const t0 = Date.now();
  const { analysisId, mediaType, frames, cropsOutputDir, onRetry } = options;
  const perFrameWatermarkMap = new Map<number, string>();

  if (frames.length === 0) {
    return {
      watermarks: [],
      ocrTexts: [],
      perFrameWatermarkMap,
      geminiSucceeded: false,
      geminiModelUsed: null,
      geminiError: null,
      watermarkDetector: {
        id: 'visible_watermark_detection',
        methodName: 'Visible Watermark & Platform Branding Detection',
        category: 'watermark',
        status: 'not_applicable',
        ran: false,
        resultSummary: 'Not applicable — no visual frames provided.',
        rawSignalScore: null,
        reliability: 'High',
        reliabilityWeight: 0.85,
        calibrationStatus: 'Deterministic Check',
        applicability: 'Images and Videos',
        evidenceStrength: 'Low',
        evidence: [],
        limitations: ['Only applies to visual media.'],
        toolUsed: 'TruthLens Watermark Module',
        correlationGroup: 'visible_watermark',
        durationMs: Date.now() - t0,
        detectorVersion: '2.0',
      },
      ocrDetector: {
        id: 'ocr_text_recognition',
        methodName: 'OCR Text Recognition',
        category: 'watermark',
        status: 'not_applicable',
        ran: false,
        resultSummary: 'Not applicable.',
        rawSignalScore: null,
        reliability: 'Moderate',
        reliabilityWeight: 0.55,
        calibrationStatus: 'Deterministic Check',
        applicability: 'Images and Videos',
        evidenceStrength: 'Low',
        evidence: [],
        limitations: [],
        toolUsed: 'TruthLens OCR Module',
        correlationGroup: 'ocr_text',
        durationMs: Date.now() - t0,
        detectorVersion: '2.0',
      },
    };
  }

  const parts: ForensicContentPart[] = [];
  const frameCatalogLines: string[] = [];

  // Inspect up to 8 frames across the full video duration (never frame 0 only)
  const selectedFrames = frames.slice(0, 8);
  for (const frame of selectedFrames) {
    const resizedFull = await sharp(frame.filePath, { limitInputPixels: MAX_IMAGE_PIXELS })
      .resize({ width: 896, height: 896, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();

    frameCatalogLines.push(
      `Frame index ${frame.frameIndex} (timestamp ${frame.timestampLabel}) — full frame attached.`,
    );
    parts.push({
      text: `[Frame index ${frame.frameIndex} | Timestamp ${frame.timestampLabel} | Full Frame]`,
    });
    parts.push({
      inlineData: {
        mimeType: 'image/jpeg',
        data: resizedFull.toString('base64'),
      },
    });
  }

  // Attach zoomed TOP-18% and BOTTOM-22% margin crops across start/mid/end frames to catch subtle Veo/Sora/Runway/Kling/Pika corner watermarks
  const cropIndices =
    selectedFrames.length >= 3
      ? [0, Math.floor(selectedFrames.length / 2), selectedFrames.length - 1]
      : [0];

  for (const cIdx of cropIndices) {
    const target = selectedFrames[cIdx];
    const [bottomStrip, topStrip] = await Promise.all([
      createEdgeStripBuffer(target.filePath, 'bottom'),
      createEdgeStripBuffer(target.filePath, 'top'),
    ]);
    if (bottomStrip) {
      parts.push({
        text: `[Zoomed Bottom-22% Edge Strip for Frame index ${target.frameIndex} (${target.timestampLabel})]`,
      });
      parts.push({
        inlineData: { mimeType: 'image/jpeg', data: bottomStrip.toString('base64') },
      });
    }
    if (topStrip && cIdx === 0) {
      parts.push({
        text: `[Zoomed Top-18% Edge Strip for Frame index ${target.frameIndex} (${target.timestampLabel})]`,
      });
      parts.push({
        inlineData: { mimeType: 'image/jpeg', data: topStrip.toString('base64') },
      });
    }
  }

  parts.push({
    text: [
      `Perform dedicated OCR text recognition and visible AI-generator watermark/logo inspection on this ${mediaType}.`,
      `Attached frames:\n${frameCatalogLines.join('\n')}`,
      'Carefully inspect all four corners, top & bottom margins, and overlaid areas for semi-transparent text, badges, or logos from AI generation platforms including: Google Veo ("Veo", Gemini/Veo star mark), OpenAI Sora ("Sora"), Runway ("Runway", Gen-2/Gen-3), Kling ("Kling", "Kling AI"), Pika ("Pika", "Pika Labs"), Luma Dream Machine, Hailuo / MiniMax, Midjourney, DALL-E (color square strip), Adobe Firefly, Stable Diffusion, Meta AI ("Imagined with AI"), or broadcaster/stock watermarks.',
      'CRITICAL RULES:',
      '- Only report a watermark or OCR text if clearly visible in the attached pixels.',
      '- Never invent or hallucinate watermarks. If none are visible, set visibleWatermarkFound=false and findings=[].',
      '- For videos, list EVERY frameIndex (from the provided indices) where the watermark persists so persistence across 3+ frames can be measured.',
      '- Do NOT claim an arbitrary logo is definitive proof of platform generation; frame it as possible association.',
      '- Distinguish visible overlay watermarks from normal scene signage (street signs, store text belong in ocrTextsFound, not AI watermarks).',
    ].join('\n'),
  });

  let aiResult: GeminiWatermarkResponse;
  let modelUsed = GEMINI_FORENSIC_MODEL;

  try {
    const res = await runStructuredGeminiAnalysisWithMeta<GeminiWatermarkResponse>({
      parts,
      responseSchema: WATERMARK_SCHEMA,
      thinkingLevel: ThinkingLevel.LOW,
      timeoutMs: 28_000,
      onRetry,
    });
    aiResult = res.data;
    modelUsed = res.modelUsed;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Upstream Gemini watermark/OCR service failed.';
    const durationMs = Date.now() - t0;
    return {
      watermarks: [],
      ocrTexts: [],
      perFrameWatermarkMap,
      geminiSucceeded: false,
      geminiModelUsed: null,
      geminiError: errMsg,
      watermarkDetector: {
        id: 'visible_watermark_detection',
        methodName: 'Visible Watermark & Generator Branding Detection',
        category: 'watermark',
        status: 'failed',
        ran: false,
        resultSummary: `Failed (recoverable) — Gemini visual watermark scan did not complete: ${errMsg} Independent local detectors continued.`,
        rawSignalScore: null,
        reliability: 'High',
        reliabilityWeight: 0.85,
        calibrationStatus: 'Deterministic Check',
        applicability: `Full-frame + top/bottom edge-strip OCR & logo scan across ${selectedFrames.length} frame(s)`,
        evidenceStrength: 'Low',
        evidence: [
          `Prepared ${selectedFrames.length} full frame(s) plus zoomed top-18% and bottom-22% edge strips locally, but multimodal vision inspection failed after retries.`,
          `Upstream error: ${errMsg}`,
        ],
        limitations: [
          'Visible watermark scanning could not complete due to temporary upstream Gemini API unavailability.',
          'API failure is NOT treated as evidence of AI generation. Use Retry Gemini Analysis to run this check against cached frames.',
        ],
        toolUsed: `TruthLens Edge-Strip Watermark Scanner (${GEMINI_FORENSIC_MODEL})`,
        correlationGroup: 'visible_watermark',
        durationMs,
        detectorVersion: '2.1',
      },
      ocrDetector: {
        id: 'ocr_text_recognition',
        methodName: 'OCR Text Recognition',
        category: 'watermark',
        status: 'failed',
        ran: false,
        resultSummary: `Failed (recoverable) — Multimodal OCR did not complete: ${errMsg}`,
        rawSignalScore: null,
        reliability: 'Moderate',
        reliabilityWeight: 0.55,
        calibrationStatus: 'Deterministic Check',
        applicability: `Text extraction across ${selectedFrames.length} frame(s)`,
        evidenceStrength: 'Low',
        evidence: [
          'No native local OCR engine (Tesseract/PaddleOCR) is installed in this runtime; multimodal OCR requires Gemini API availability.',
        ],
        limitations: [
          'Retry Gemini Analysis once upstream service load normalizes to complete OCR extraction.',
        ],
        toolUsed: `Multimodal OCR (${GEMINI_FORENSIC_MODEL})`,
        correlationGroup: 'ocr_text',
        durationMs,
        detectorVersion: '2.1',
      },
    };
  }

  const validFindings = (aiResult.findings ?? []).filter(
    (f) => f.detected && f.recognizedTextOrLogo?.trim(),
  );
  const totalFrames = selectedFrames.length;
  const watermarks: WatermarkFinding[] = [];

  for (let i = 0; i < validFindings.length; i++) {
    const item = validFindings[i];
    const indices =
      Array.isArray(item.frameIndices) && item.frameIndices.length > 0
        ? item.frameIndices.filter((idx) => frames.some((f) => f.frameIndex === idx))
        : [selectedFrames[0].frameIndex];

    const firstFrame = frames.find((f) => f.frameIndex === indices[0]) ?? selectedFrames[0];
    const persistentCount = indices.length;
    const isPersistent = mediaType === 'video' && persistentCount >= Math.min(3, Math.ceil(totalFrames * 0.5));
    const persistenceText =
      mediaType === 'video'
        ? `Observed in ${persistentCount} of ${totalFrames} inspected frames (${indices
            .map((idx) => frames.find((f) => f.frameIndex === idx)?.timestampLabel ?? `#${idx}`)
            .join(', ')}).`
        : 'Observed in still image.';

    let cropImageUrl: string | null = null;
    if (cropsOutputDir) {
      const cropFileName = `wm_crop_${i + 1}.jpg`;
      const saved = await saveEvidenceCrop(
        firstFrame.filePath,
        item.positionInFrame,
        cropsOutputDir,
        cropFileName,
      );
      if (saved) {
        cropImageUrl = `/api/analyses/${analysisId}/watermarks/${cropFileName}`;
      }
    }

    for (const idx of indices) {
      const existing = perFrameWatermarkMap.get(idx);
      const label = `${item.recognizedTextOrLogo} (${item.positionInFrame})`;
      perFrameWatermarkMap.set(idx, existing ? `${existing}; ${label}` : label);
    }

    watermarks.push({
      id: `wm_visible_${i + 1}`,
      type: item.type === 'visible_logo' ? 'visible_logo' : 'visible_text',
      detected: true,
      recognizedTextOrLogo: item.recognizedTextOrLogo,
      timestamp: mediaType === 'video' ? firstFrame.timestampLabel : null,
      frameIndex: mediaType === 'video' ? firstFrame.frameIndex : null,
      positionInFrame: item.positionInFrame,
      detectionMethod:
        item.type === 'visible_logo'
          ? 'Full-Frame + Edge-Strip Logo Recognition'
          : 'Full-Frame + Edge-Strip OCR Inspection',
      recognitionConfidence:
        item.recognitionConfidence === 'High' || item.recognitionConfidence === 'Moderate'
          ? item.recognitionConfidence
          : 'Low',
      possiblePlatform:
        item.possiblePlatform && item.possiblePlatform !== 'Unknown' ? item.possiblePlatform : null,
      persistentAcrossFrames: mediaType === 'video' ? isPersistent : undefined,
      persistentFrameCount: mediaType === 'video' ? persistentCount : 1,
      persistenceSummary: persistenceText,
      cropImageUrl,
      note: item.evidenceNote || aiResult.overallAssessment,
    });
  }

  const aiPlatformPattern =
    /veo|sora|runway|kling|pika|luma|hailuo|minimax|midjourney|dall-?e|firefly|imagined with ai|meta ai|heygen|synthesia|stable diffusion|ideogram|flux/i;
  const aiBrandedMatches = watermarks.filter(
    (w) =>
      aiPlatformPattern.test(w.possiblePlatform ?? '') ||
      aiPlatformPattern.test(w.recognizedTextOrLogo ?? ''),
  );

  let rawSignalScore: number | null = null;
  let resultSummary =
    'No visible AI-generator watermarks or platform marks were observed across full frames and edge strips (absence does not prove authenticity).';
  let evidenceStrength: 'Low' | 'Moderate' | 'Strong' = 'Low';
  const evidence: string[] = [];

  if (aiBrandedMatches.length > 0) {
    const highConf = aiBrandedMatches.some((w) => w.recognitionConfidence === 'High');
    const persistent = aiBrandedMatches.some((w) => w.persistentAcrossFrames);
    rawSignalScore = persistent ? 92 : highConf ? 86 : 68;
    evidenceStrength = highConf || persistent ? 'Strong' : 'Moderate';
    resultSummary = `Visible watermark/branding possibly associated with ${aiBrandedMatches
      .map((w) => w.possiblePlatform || w.recognizedTextOrLogo)
      .join(', ')} detected.`;
    for (const wm of aiBrandedMatches) {
      evidence.push(
        `Detected "${wm.recognizedTextOrLogo}" at ${wm.positionInFrame}${wm.timestamp ? ` (first seen ${wm.timestamp})` : ''} — confidence: ${wm.recognitionConfidence}. ${wm.persistenceSummary ?? ''}`,
      );
    }
  } else if (watermarks.length > 0) {
    rawSignalScore = null;
    evidenceStrength = 'Low';
    resultSummary = `Visible overlay mark(s) detected (${watermarks
      .map((w) => w.recognizedTextOrLogo)
      .join(', ')}), not directly identified as a known AI generator watermark.`;
    for (const wm of watermarks) {
      evidence.push(
        `Overlay "${wm.recognizedTextOrLogo}" at ${wm.positionInFrame} (${wm.recognitionConfidence} confidence).`,
      );
    }
  } else {
    evidence.push(
      mediaType === 'video'
        ? `Inspected ${totalFrames} sampled frames plus top-18% and bottom-22% zoomed margin strips: no visible AI platform text or logos detected.`
        : 'Inspected full image plus zoomed top and bottom margin strips: no visible AI platform text or logos detected.',
    );
  }

  const durationMs = Date.now() - t0;

  const watermarkDetector: DetectorResult = {
    id: 'visible_watermark_detection',
    methodName: 'Visible Watermark & Generator Branding Detection',
    category: 'watermark',
    status: 'completed',
    ran: true,
    resultSummary,
    rawSignalScore,
    reliability: aiBrandedMatches.length > 0 ? 'High' : 'Moderate',
    reliabilityWeight: 0.85,
    calibrationStatus: 'Deterministic Check',
    applicability: `Full-frame + top/bottom edge-strip OCR & logo scan across ${totalFrames} frame(s)`,
    evidenceStrength,
    evidence,
    limitations: [
      'Visible watermarks can be cropped out, blurred, or added artificially to non-AI content.',
      'Absence of a visible watermark never proves content is authentic.',
      'Recognizing a logo or text suggests possible platform association rather than cryptographic proof.',
    ],
    toolUsed: `TruthLens Edge-Strip Watermark Scanner (${modelUsed})`,
    correlationGroup: 'visible_watermark',
    durationMs,
    detectorVersion: '2.1',
  };

  const ocrTexts = (aiResult.ocrTextsFound ?? []).filter((t) => t && t.trim().length > 0);
  const ocrDetector: DetectorResult = {
    id: 'ocr_text_recognition',
    methodName: 'OCR Text Recognition',
    category: 'watermark',
    status: 'completed',
    ran: true,
    resultSummary:
      ocrTexts.length > 0
        ? `Extracted ${ocrTexts.length} visible text string(s) from visual content.`
        : 'No legible embedded or overlaid text detected.',
    rawSignalScore: null,
    reliability: 'Moderate',
    reliabilityWeight: 0.55,
    calibrationStatus: 'Deterministic Check',
    applicability: `Text extraction across ${totalFrames} frame(s)`,
    evidenceStrength: ocrTexts.length > 0 ? 'Moderate' : 'Low',
    evidence:
      ocrTexts.length > 0
        ? [`Recognized text excerpts: ${ocrTexts.slice(0, 12).map((t) => `"${t}"`).join(', ')}`]
        : ['No readable signage, captions, or text overlays observed in inspected frames.'],
    limitations: [
      'Small, heavily compressed, or motion-blurred text may not be readable.',
    ],
    toolUsed: `Multimodal OCR (${modelUsed})`,
    correlationGroup: 'ocr_text',
    durationMs,
    detectorVersion: '2.1',
  };

  return {
    watermarks,
    ocrTexts,
    watermarkDetector,
    ocrDetector,
    perFrameWatermarkMap,
    geminiSucceeded: true,
    geminiModelUsed: modelUsed,
    geminiError: null,
  };
}
