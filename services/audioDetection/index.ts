import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';
import { Type, ThinkingLevel } from '@google/genai';
import type {
  AudioProfile,
  AudioSegmentFinding,
  DetectorResult,
  ExtractedMetadata,
  WatermarkFinding,
} from '../../src/types/forensics.ts';
import {
  GEMINI_FORENSIC_MODEL,
  type GeminiRetryEvent,
  runStructuredGeminiAnalysisWithMeta,
} from '../geminiClient.ts';
import type { ProvenanceInspectionOutput } from '../provenanceVerification/index.ts';

const execFileAsync = promisify(execFile);

interface GeminiAudioForensicsResponse {
  speechDetected: boolean;
  aiSpeechScore: number | null;
  aiSpeechSummary: string;
  aiSpeechEvidence: string[];
  prosodyScore: number | null;
  prosodySummary: string;
  prosodyEvidence: string[];
  artifactScore: number;
  artifactSummary: string;
  artifactEvidence: string[];
  voiceConsistencyScore: number | null;
  voiceConsistencySummary: string;
  voiceConsistencyEvidence: string[];
  vocoderArtifactsDetected: boolean;
  unnaturalProsodyDetected: boolean;
  syntheticBreathingOrPausesDetected: boolean;
  timbreOrFormantAnomaliesDetected: boolean;
  roomToneDiscontinuityDetected: boolean;
  detectedSyntheticEvidence: string[];
  uncertainSignals: string[];
  naturalHumanCues: string[];
  notableTimestampObservations: Array<{
    timestampLabel: string;
    observation: string;
  }>;
}

const AUDIO_FORENSICS_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    speechDetected: { type: Type.BOOLEAN },
    aiSpeechScore: { type: Type.INTEGER, nullable: true },
    aiSpeechSummary: { type: Type.STRING },
    aiSpeechEvidence: { type: Type.ARRAY, items: { type: Type.STRING } },
    prosodyScore: { type: Type.INTEGER, nullable: true },
    prosodySummary: { type: Type.STRING },
    prosodyEvidence: { type: Type.ARRAY, items: { type: Type.STRING } },
    artifactScore: { type: Type.INTEGER },
    artifactSummary: { type: Type.STRING },
    artifactEvidence: { type: Type.ARRAY, items: { type: Type.STRING } },
    voiceConsistencyScore: { type: Type.INTEGER, nullable: true },
    voiceConsistencySummary: { type: Type.STRING },
    voiceConsistencyEvidence: { type: Type.ARRAY, items: { type: Type.STRING } },
    vocoderArtifactsDetected: { type: Type.BOOLEAN },
    unnaturalProsodyDetected: { type: Type.BOOLEAN },
    syntheticBreathingOrPausesDetected: { type: Type.BOOLEAN },
    timbreOrFormantAnomaliesDetected: { type: Type.BOOLEAN },
    roomToneDiscontinuityDetected: { type: Type.BOOLEAN },
    detectedSyntheticEvidence: { type: Type.ARRAY, items: { type: Type.STRING } },
    uncertainSignals: { type: Type.ARRAY, items: { type: Type.STRING } },
    naturalHumanCues: { type: Type.ARRAY, items: { type: Type.STRING } },
    notableTimestampObservations: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          timestampLabel: { type: Type.STRING },
          observation: { type: Type.STRING },
        },
        required: ['timestampLabel', 'observation'],
      },
    },
  },
  required: [
    'speechDetected',
    'aiSpeechSummary',
    'aiSpeechEvidence',
    'prosodySummary',
    'prosodyEvidence',
    'artifactScore',
    'artifactSummary',
    'artifactEvidence',
    'voiceConsistencySummary',
    'voiceConsistencyEvidence',
    'vocoderArtifactsDetected',
    'unnaturalProsodyDetected',
    'syntheticBreathingOrPausesDetected',
    'timbreOrFormantAnomaliesDetected',
    'roomToneDiscontinuityDetected',
    'detectedSyntheticEvidence',
    'uncertainSignals',
    'naturalHumanCues',
    'notableTimestampObservations',
  ],
};

function formatAudioTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}

async function computeAcousticProfile(filePath: string): Promise<AudioProfile> {
  const sampleRate = 16000;
  // Decode up to first 90 seconds into raw 16kHz mono signed 16-bit PCM for real acoustic signal analysis
  const { stdout } = await execFileAsync(
    'ffmpeg',
    [
      '-i',
      filePath,
      '-t',
      '90',
      '-ac',
      '1',
      '-ar',
      String(sampleRate),
      '-f',
      's16le',
      '-v',
      'error',
      'pipe:1',
    ],
    { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024, timeout: 25_000 },
  );

  const sampleCount = Math.floor(stdout.length / 2);
  if (sampleCount < 256) {
    return {
      waveformPeaks: [0.1, 0.2, 0.15, 0.1],
      spectralCentroidHz: null,
      highFreqEnergyRatio: null,
      silenceRatio: 1,
      dynamicRangeDb: 0,
      clippingRate: 0,
      noiseFloorDb: null,
      spectralFlatness: null,
      detectedIndicators: [],
      uncertainSignals: ['Audio clip too short (< 256 PCM samples) for reliable acoustic profiling.'],
      naturalCues: [],
      segments: [],
    };
  }

  const samples = new Float32Array(sampleCount);
  let silentCount = 0;
  let clippedCount = 0;

  for (let i = 0; i < sampleCount; i++) {
    const val = stdout.readInt16LE(i * 2) / 32768;
    samples[i] = val;
    const abs = Math.abs(val);
    if (abs < 0.008) silentCount++;
    if (abs >= 0.992) clippedCount++;
  }

  // Build 64-bin waveform peaks for visualization
  const numBins = 64;
  const binSize = Math.max(1, Math.floor(sampleCount / numBins));
  const waveformPeaks: number[] = [];
  for (let b = 0; b < numBins; b++) {
    let peak = 0;
    const start = b * binSize;
    const end = Math.min(sampleCount, start + binSize);
    for (let i = start; i < end; i++) {
      const a = Math.abs(samples[i]);
      if (a > peak) peak = a;
    }
    waveformPeaks.push(Number(peak.toFixed(3)));
  }

  // Compute short-frame noise floor estimate (100ms windows, 15th percentile RMS)
  const frameLen = Math.floor(sampleRate * 0.1);
  const frameRmsDbs: number[] = [];
  for (let fStart = 0; fStart + frameLen <= sampleCount; fStart += frameLen) {
    let sq = 0;
    for (let i = fStart; i < fStart + frameLen; i++) {
      sq += samples[i] * samples[i];
    }
    const rms = Math.sqrt(sq / frameLen);
    frameRmsDbs.push(20 * Math.log10(Math.max(rms, 1e-6)));
  }
  frameRmsDbs.sort((a, b) => a - b);
  const noiseFloorDb =
    frameRmsDbs.length >= 4
      ? Number(frameRmsDbs[Math.floor(frameRmsDbs.length * 0.15)].toFixed(1))
      : null;

  // Segment-level RMS (dB) and Zero-Crossing Rate (ZCR) across 3–8 time windows
  const totalSec = sampleCount / sampleRate;
  const numSegs = Math.min(8, Math.max(3, Math.ceil(totalSec / 3)));
  const segLen = Math.floor(sampleCount / numSegs);
  const rmsValues: number[] = [];
  const segments: AudioSegmentFinding[] = [];

  for (let s = 0; s < numSegs; s++) {
    const startIdx = s * segLen;
    const endIdx = s === numSegs - 1 ? sampleCount : (s + 1) * segLen;
    let sqSum = 0;
    let zcr = 0;
    for (let i = startIdx; i < endIdx; i++) {
      sqSum += samples[i] * samples[i];
      if (
        i > startIdx &&
        ((samples[i] >= 0 && samples[i - 1] < 0) || (samples[i] < 0 && samples[i - 1] >= 0))
      ) {
        zcr++;
      }
    }
    const count = Math.max(1, endIdx - startIdx);
    const rms = Math.sqrt(sqSum / count);
    const rmsDb = Number((20 * Math.log10(Math.max(rms, 1e-6))).toFixed(1));
    const zcrRate = Number((zcr / count).toFixed(4));
    rmsValues.push(rmsDb);

    const startSec = Number((startIdx / sampleRate).toFixed(1));
    const endSec = Number((endIdx / sampleRate).toFixed(1));
    let observation = 'Nominal acoustic energy and zero-crossing profile.';
    let flagged = false;
    if (rmsDb < -52) {
      observation = 'Near-digital-zero silence floor (minimal ambient room tone — uncertain signal; occurs in TTS and heavy noise gates).';
      flagged = true;
    } else if (zcrRate > 0.28) {
      observation = 'Elevated high-frequency zero-crossing density (possible metallic vocoder sibilance or codec noise).';
      flagged = true;
    }

    segments.push({
      startSec,
      endSec,
      timestampLabel: `${formatAudioTime(startSec)} – ${formatAudioTime(endSec)}`,
      rmsDb,
      zeroCrossingRate: zcrRate,
      observation,
      flagged,
    });
  }

  // Multi-window 256-point DFT across 5 evenly spaced active offsets for stable spectral centroid & flatness
  const fftN = 256;
  const windowOffsets = [0.15, 0.32, 0.5, 0.68, 0.85]
    .map((frac) => Math.max(0, Math.min(sampleCount - fftN, Math.floor(sampleCount * frac))))
    .filter((off, i, arr) => arr.indexOf(off) === i);

  let centroidAccum = 0;
  let highFreqAccum = 0;
  let flatnessAccum = 0;
  let validWindows = 0;

  for (const offset of windowOffsets) {
    let weightedFreqSum = 0;
    let magSum = 0;
    let highFreqMag = 0;
    let logMagSum = 0;
    const bins = fftN / 2 - 1;

    for (let k = 1; k < fftN / 2; k++) {
      let re = 0;
      let im = 0;
      for (let n = 0; n < fftN; n++) {
        const sample = samples[offset + n] ?? 0;
        const win = 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / (fftN - 1));
        const angle = (2 * Math.PI * k * n) / fftN;
        re += sample * win * Math.cos(angle);
        im -= sample * win * Math.sin(angle);
      }
      const mag = Math.sqrt(re * re + im * im);
      const freqHz = (k * sampleRate) / fftN;
      weightedFreqSum += freqHz * mag;
      magSum += mag;
      logMagSum += Math.log(Math.max(mag, 1e-7));
      if (freqHz >= 4000) highFreqMag += mag;
    }

    if (magSum > 0.01) {
      centroidAccum += weightedFreqSum / magSum;
      highFreqAccum += highFreqMag / magSum;
      const geoMean = Math.exp(logMagSum / bins);
      const arithMean = magSum / bins;
      flatnessAccum += arithMean > 0 ? geoMean / arithMean : 0;
      validWindows++;
    }
  }

  const spectralCentroidHz = validWindows > 0 ? Math.round(centroidAccum / validWindows) : null;
  const highFreqEnergyRatio =
    validWindows > 0 ? Number((highFreqAccum / validWindows).toFixed(3)) : null;
  const spectralFlatness =
    validWindows > 0 ? Number((flatnessAccum / validWindows).toFixed(3)) : null;

  const activeRms = rmsValues.filter((v) => v > -60);
  const dynamicRangeDb =
    activeRms.length >= 2
      ? Number((Math.max(...activeRms) - Math.min(...activeRms)).toFixed(1))
      : 0;

  return {
    waveformPeaks,
    spectralCentroidHz,
    highFreqEnergyRatio,
    silenceRatio: Number((silentCount / sampleCount).toFixed(3)),
    dynamicRangeDb,
    clippingRate: Number((clippedCount / sampleCount).toFixed(4)),
    noiseFloorDb,
    spectralFlatness,
    detectedIndicators: [],
    uncertainSignals: [],
    naturalCues: [],
    segments,
  };
}

export interface AudioPipelineOutput {
  detectors: DetectorResult[];
  watermarks: WatermarkFinding[];
  audioProfile: AudioProfile;
  geminiStatus: 'completed' | 'failed';
  geminiModelUsed: string | null;
  geminiFailureDetail: string | null;
}

export async function runAudioDetectionPipeline(options: {
  filePath: string;
  metadata: ExtractedMetadata;
  provenance: ProvenanceInspectionOutput;
  onStageProgress?: (
    stageId: 'forensic_analysis' | 'ai_assessment',
    detail: string,
    statusOverride?: 'running' | 'retrying',
  ) => void;
}): Promise<AudioPipelineOutput> {
  const { filePath, metadata, provenance, onStageProgress } = options;

  onStageProgress?.(
    'forensic_analysis',
    'Decoding 16 kHz PCM waveform and computing multi-window spectral centroid, flatness, noise floor, silence ratio, and dynamic range.',
  );
  const audioProfile = await computeAcousticProfile(filePath);

  onStageProgress?.(
    'ai_assessment',
    'Evaluating audio for multi-indicator AI-generated speech cues, prosody, vocoder artifacts, and separating detected evidence from uncertain signals.',
  );

  // Prepare audio payload for Gemini (cap at ~12MB inline or transcode snippet to MP3 if oversized)
  let audioBytes = await fs.readFile(filePath);
  let audioMime = metadata.detectedMime;
  if (audioMime === 'audio/x-wav' || audioMime === 'audio/vnd.wave') audioMime = 'audio/wav';
  if (audioMime === 'audio/x-m4a' || audioMime === 'audio/m4a') audioMime = 'audio/mp4';

  if (audioBytes.length > 12 * 1024 * 1024) {
    const { stdout } = await execFileAsync(
      'ffmpeg',
      ['-i', filePath, '-t', '60', '-ac', '1', '-ar', '22050', '-b:a', '96k', '-f', 'mp3', '-v', 'error', 'pipe:1'],
      { encoding: 'buffer', maxBuffer: 12 * 1024 * 1024, timeout: 25_000 },
    );
    audioBytes = stdout;
    audioMime = 'audio/mpeg';
  }

  let aiAudio: GeminiAudioForensicsResponse | null = null;
  let aiModelUsed: string | null = null;
  let aiAudioError: string | null = null;

  try {
    const res = await runStructuredGeminiAnalysisWithMeta<GeminiAudioForensicsResponse>({
      parts: [
        {
          inlineData: {
            mimeType: audioMime,
            data: audioBytes.toString('base64'),
          },
        },
        {
          text: [
            'Perform a rigorous multi-indicator forensic assessment of this audio recording for signs of AI-generated / synthetic speech (TTS, neural voice cloning, vocoder synthesis) vs genuine human microphone capture.',
            'Measured deterministic PCM acoustic telemetry:',
            `- Format: ${metadata.audioFormat ?? 'Unknown'}, Codec: ${metadata.codec ?? 'Unknown'}, Duration: ${metadata.durationSeconds ?? 'Unknown'}s, Sample Rate: ${metadata.sampleRate ?? 'Unknown'} Hz, Channels: ${metadata.audioChannels ?? 'Unknown'}`,
            `- Multi-window Spectral Centroid: ${audioProfile.spectralCentroidHz ?? 'N/A'} Hz | High-Freq (>=4kHz) Energy Ratio: ${audioProfile.highFreqEnergyRatio ?? 'N/A'} | Spectral Flatness: ${audioProfile.spectralFlatness ?? 'N/A'}`,
            `- 15th-Percentile Noise Floor: ${audioProfile.noiseFloorDb ?? 'N/A'} dB | Silence Ratio: ${(audioProfile.silenceRatio * 100).toFixed(1)}% | Dynamic Range: ${audioProfile.dynamicRangeDb} dB | Clipping Rate: ${(audioProfile.clippingRate * 100).toFixed(2)}%`,
            '',
            'MULTI-INDICATOR EVALUATION RULES:',
            '1. Evaluate 5 distinct acoustic dimensions independently: (a) neural vocoder/spectral artifacts (metallic buzz, phase smearing, harmonic shimmer), (b) unnatural prosody/intonation cadence, (c) synthetic breathing or unnaturally gated inter-phrase pauses, (d) timbre/formant instability or phoneme slurring, and (e) room-tone discontinuity.',
            '2. Clearly separate concrete DETECTED synthetic speech evidence (detectedSyntheticEvidence) from UNCERTAIN signals (uncertainSignals, e.g., clean studio mic, podcast compression, noise suppression like Krisp/RNNoise, or scripted broadcast reading) and NATURAL human cues (naturalHumanCues, e.g., organic breath intakes, micro-hesitations, natural room acoustics).',
            '3. NEVER assign a high AI score (>= 70) from a single isolated cue — only assign >= 70 when MULTIPLE independent speech indicators clearly point to synthetic speech. When multiple clear AI speech indicators converge, reflect that stronger confidence appropriately (e.g., 72–90), while never claiming 100% certainty.',
            '4. If no intelligible human speech is present (e.g. pure tone, instrumental music, ambient sound), set speechDetected=false and leave speech-only scores null.',
          ].join('\n'),
        },
      ],
      responseSchema: AUDIO_FORENSICS_SCHEMA,
      thinkingLevel: ThinkingLevel.LOW,
      timeoutMs: 32_000,
      onRetry: (evt: GeminiRetryEvent) => {
        onStageProgress?.(
          'ai_assessment',
          `Gemini audio review retrying (${evt.attempt}/${evt.totalAttempts} → ${evt.nextModel} in ${(evt.delayMs / 1000).toFixed(1)}s): ${evt.reason}`,
          'retrying',
        );
      },
    });
    aiAudio = res.data;
    aiModelUsed = res.modelUsed;
  } catch (err) {
    aiAudioError = err instanceof Error ? err.message : 'Gemini audio forensic analysis failed.';
  }

  // Merge any AI timestamp notes into segment observations
  if (aiAudio?.notableTimestampObservations?.length) {
    for (const obs of aiAudio.notableTimestampObservations) {
      audioProfile.segments.push({
        startSec: 0,
        endSec: 0,
        timestampLabel: obs.timestampLabel,
        rmsDb: 0,
        zeroCrossingRate: 0,
        observation: `Multimodal observation: ${obs.observation}`,
        flagged: true,
      });
    }
  }

  const encoderAiPattern = /elevenlabs|murf|playht|resemble|bark|tortoise|vits|xtts|suno|udio|lyria|openai[\s_-]*tts|coqui|fish[\s_-]*audio/i;
  const encoderMatchesAi = Boolean(metadata.encoder && encoderAiPattern.test(metadata.encoder));

  // Deterministic PCM acoustic indicators (clearly split between concrete cues and uncertain signals)
  const pcmDetectedCues: string[] = [];
  const pcmUncertainSignals: string[] = [];
  const pcmNaturalCues: string[] = [];

  const hasDigitalZeroFloor =
    audioProfile.noiseFloorDb !== null &&
    audioProfile.noiseFloorDb !== undefined &&
    audioProfile.noiseFloorDb <= -55 &&
    audioProfile.silenceRatio >= 0.06 &&
    audioProfile.silenceRatio <= 0.72;

  const hasCompressedFlatDynamics =
    audioProfile.dynamicRangeDb > 0 &&
    audioProfile.dynamicRangeDb <= 3.2 &&
    (metadata.durationSeconds ?? 0) >= 3;

  const hasElevatedHighFreqSibilance =
    audioProfile.highFreqEnergyRatio !== null &&
    audioProfile.highFreqEnergyRatio >= 0.42 &&
    audioProfile.segments.some((s) => s.zeroCrossingRate > 0.28);

  if (hasDigitalZeroFloor) {
    pcmUncertainSignals.push(
      `Near-digital-zero quiet floor (${audioProfile.noiseFloorDb} dB across ${(audioProfile.silenceRatio * 100).toFixed(1)}% quiet frames) — commonly seen in neural TTS exports, though studio noise-gating/Krisp can produce similar silence.`,
    );
  } else if (
    audioProfile.noiseFloorDb !== null &&
    audioProfile.noiseFloorDb !== undefined &&
    audioProfile.noiseFloorDb > -48 &&
    audioProfile.noiseFloorDb < -22
  ) {
    pcmNaturalCues.push(
      `Continuous ambient acoustic noise floor (${audioProfile.noiseFloorDb} dB) consistent with live microphone room tone.`,
    );
  }

  if (hasCompressedFlatDynamics) {
    pcmUncertainSignals.push(
      `Narrow inter-window dynamic range (${audioProfile.dynamicRangeDb} dB) — occurs in steady TTS prosody as well as heavily compressed podcast/broadcast mastering.`,
    );
  } else if (audioProfile.dynamicRangeDb >= 7) {
    pcmNaturalCues.push(
      `Expressive dynamic range (${audioProfile.dynamicRangeDb} dB) across active speech windows.`,
    );
  }

  if (hasElevatedHighFreqSibilance) {
    pcmDetectedCues.push(
      `Elevated high-frequency energy ratio (${((audioProfile.highFreqEnergyRatio ?? 0) * 100).toFixed(1)}% >= 4 kHz) paired with high zero-crossing sibilance density.`,
    );
  }

  // Only treat deterministic PCM as a corroborating synthetic signal if multiple PCM traits align
  const pcmCorroboratesSynthetic =
    (hasDigitalZeroFloor && hasCompressedFlatDynamics) ||
    (hasDigitalZeroFloor && hasElevatedHighFreqSibilance);

  // Tally independent synthetic speech indicators across all modalities
  const speechDetected = Boolean(aiAudio?.speechDetected);
  const independentIndicators: string[] = [];

  if (speechDetected && aiAudio) {
    if (aiAudio.vocoderArtifactsDetected || aiAudio.artifactScore >= 64) {
      independentIndicators.push('Neural vocoder / metallic spectral artifacts');
    }
    if (aiAudio.unnaturalProsodyDetected || (typeof aiAudio.prosodyScore === 'number' && aiAudio.prosodyScore >= 64)) {
      independentIndicators.push('Unnatural prosody / synthetic intonation cadence');
    }
    if (aiAudio.syntheticBreathingOrPausesDetected) {
      independentIndicators.push('Synthetic breathing or artificially gated inter-phrase pauses');
    }
    if (
      aiAudio.timbreOrFormantAnomaliesDetected ||
      aiAudio.roomToneDiscontinuityDetected ||
      (typeof aiAudio.voiceConsistencyScore === 'number' && aiAudio.voiceConsistencyScore >= 64)
    ) {
      independentIndicators.push('Voice timbre/formant anomalies or room-tone discontinuity');
    }
    if (pcmCorroboratesSynthetic) {
      independentIndicators.push('Deterministic PCM digital-zero floor + uniform dynamic envelope');
    }
  }
  if (encoderMatchesAi) {
    independentIndicators.push(`AI synthesis encoder metadata tag ("${metadata.encoder}")`);
  }

  const indicatorCount = independentIndicators.length;

  // Populate structured AudioProfile detected evidence vs uncertain signals vs natural cues
  audioProfile.speechDetected = speechDetected;
  audioProfile.syntheticIndicatorCount = indicatorCount;
  audioProfile.detectedIndicators = [
    ...(aiAudio?.detectedSyntheticEvidence ?? []),
    ...pcmDetectedCues,
    ...(encoderMatchesAi ? [`Audio container encoder matches known AI synthesis tool: "${metadata.encoder}".`] : []),
  ];
  audioProfile.uncertainSignals = [
    ...(aiAudio?.uncertainSignals ?? []),
    ...pcmUncertainSignals,
  ];
  audioProfile.naturalCues = [
    ...(aiAudio?.naturalHumanCues ?? []),
    ...pcmNaturalCues,
  ];

  // Multi-indicator calibrated AI-generated speech score:
  // - Multiple corroborating indicators -> boost confidence proportionally (up to 94)
  // - Single isolated indicator -> cap conservatively at <= 58 (never auto-label as AI-generated from 1 cue)
  let calibratedAiSpeechScore: number | null = null;
  let aiSpeechReliability: DetectorResult['reliability'] = 'Experimental';
  let aiSpeechWeight = 0.5;
  let aiSpeechStrength: DetectorResult['evidenceStrength'] = 'Low';
  let aiSpeechSummary = aiAudio?.speechDetected
    ? aiAudio.aiSpeechSummary
    : 'Not applicable — no intelligible human speech detected in this recording.';
  const aiSpeechEvidence = [...(aiAudio?.aiSpeechEvidence ?? [])];

  if (aiAudio && aiAudio.speechDetected && typeof aiAudio.aiSpeechScore === 'number') {
    const baseScore = Math.max(5, Math.min(92, aiAudio.aiSpeechScore));
    if (indicatorCount >= 3) {
      calibratedAiSpeechScore = Math.min(94, Math.max(baseScore + 12, 76));
      aiSpeechReliability = 'Moderate';
      aiSpeechWeight = 0.78;
      aiSpeechStrength = 'Strong';
      aiSpeechSummary = `${aiAudio.aiSpeechSummary} Corroborated by ${indicatorCount} independent audio indicators (${independentIndicators.slice(0, 3).join('; ')}).`;
      aiSpeechEvidence.unshift(
        `Multi-indicator corroboration (${indicatorCount} independent cues): ${independentIndicators.join('; ')}.`,
      );
    } else if (indicatorCount === 2) {
      calibratedAiSpeechScore = Math.min(89, Math.max(baseScore + 7, 68));
      aiSpeechReliability = 'Moderate';
      aiSpeechWeight = 0.68;
      aiSpeechStrength = 'Moderate';
      aiSpeechSummary = `${aiAudio.aiSpeechSummary} Supported by 2 corroborating audio indicators (${independentIndicators.join('; ')}).`;
      aiSpeechEvidence.unshift(
        `Multi-indicator corroboration (2 independent cues): ${independentIndicators.join('; ')}.`,
      );
    } else if (indicatorCount === 1 && baseScore >= 59) {
      // Single-indicator anti-false-positive guard
      calibratedAiSpeechScore = Math.min(58, baseScore);
      aiSpeechReliability = 'Experimental';
      aiSpeechWeight = 0.45;
      aiSpeechStrength = 'Low';
      aiSpeechSummary = `Uncertain signal only (${independentIndicators[0]}) — score capped at ${calibratedAiSpeechScore}/100 because a single audio indicator is insufficient to label speech as AI-generated. ${aiAudio.aiSpeechSummary}`;
      aiSpeechEvidence.unshift(
        `Single-indicator safeguard: Only 1 cue (${independentIndicators[0]}) was flagged without corroborating indicators; treated as uncertain signal rather than confirmed synthetic speech.`,
      );
    } else {
      calibratedAiSpeechScore = baseScore;
      aiSpeechReliability = 'Experimental';
      aiSpeechWeight = 0.52;
      aiSpeechStrength = baseScore <= 35 && audioProfile.naturalCues.length >= 2 ? 'Moderate' : 'Low';
    }
  }

  const spectralPolarity: DetectorResult['signalPolarity'] =
    pcmCorroboratesSynthetic && speechDetected
      ? 'ai_indicator'
      : pcmNaturalCues.length >= 2
        ? 'natural_capture'
        : 'neutral';

  const spectralScore: number | null =
    pcmCorroboratesSynthetic && speechDetected && indicatorCount >= 2
      ? 66
      : pcmNaturalCues.length >= 2 && indicatorCount === 0
        ? 30
        : null;

  const detectors: DetectorResult[] = [
    aiAudio
      ? {
          id: 'ai_speech_classification',
          methodName: 'AI-Generated Speech Classification',
          category: 'ai_reasoning',
          status: aiAudio.speechDetected ? 'completed' : 'not_applicable',
          ran: aiAudio.speechDetected,
          resultSummary: aiSpeechSummary,
          rawSignalScore: calibratedAiSpeechScore,
          signalPolarity:
            calibratedAiSpeechScore === null
              ? 'neutral'
              : calibratedAiSpeechScore >= 62
                ? 'ai_indicator'
                : calibratedAiSpeechScore <= 38
                  ? 'natural_capture'
                  : 'neutral',
          reliability: aiSpeechReliability,
          reliabilityWeight: aiSpeechWeight,
          calibrationStatus: 'Uncalibrated (Experimental)',
          applicability: 'Spoken-word recordings (multi-indicator speech synthesis analysis)',
          evidenceStrength: aiSpeechStrength,
          evidence: [
            ...aiSpeechEvidence,
            ...(audioProfile.uncertainSignals.length > 0
              ? [`Uncertain signals (not treated as proof): ${audioProfile.uncertainSignals.slice(0, 2).join(' ')}`]
              : []),
          ],
          limitations: [
            'Multimodal audio reasoning is experimental and can be influenced by heavy studio noise-gating, podcast compression, or low-bitrate codecs.',
            'Single-indicator safeguard prevents automatic AI labeling unless multiple independent speech indicators align.',
          ],
          toolUsed: `Gemini Multi-Indicator Audio Analysis (${aiModelUsed ?? GEMINI_FORENSIC_MODEL})`,
          correlationGroup: 'audio_ai_speech',
        }
      : {
          id: 'ai_speech_classification',
          methodName: 'AI-Generated Speech Classification',
          category: 'ai_reasoning',
          status: 'failed',
          ran: false,
          resultSummary: `Failed (recoverable) — Gemini audio classification unavailable: ${aiAudioError}`,
          rawSignalScore: null,
          reliability: 'Experimental',
          calibrationStatus: 'Uncalibrated (Experimental)',
          applicability: 'Spoken-word recordings',
          evidenceStrength: 'Low',
          evidence: [`Upstream error: ${aiAudioError}`],
          limitations: ['Excluded from scoring; retry Gemini analysis when available.'],
          toolUsed: `Gemini Multi-Indicator Audio Analysis (${GEMINI_FORENSIC_MODEL})`,
          correlationGroup: 'audio_ai_speech',
        },
    {
      id: 'voice_cloning_biometric',
      methodName: 'Specialized Voice-Cloning Biometric Detector',
      category: 'signal',
      status: 'unavailable',
      ran: false,
      resultSummary:
        'Not performed — dedicated ASVspoof / RawNet2 / AASIST neural anti-spoofing model is not installed in this server environment.',
      rawSignalScore: null,
      reliability: 'High',
      calibrationStatus: 'Calibrated',
      applicability: 'Voice cloning and neural vocoder detection',
      evidenceStrength: 'Low',
      evidence: [
        'Requires a dedicated neural anti-spoofing classifier (e.g., AASIST/RawNet2) plus speaker reference audio for biometric verification.',
      ],
      limitations: [
        'Without a reference speaker enrollment sample, verifying whether a specific person’s voice was cloned is not possible.',
      ],
      toolUsed: 'Not integrated (Unavailable)',
      correlationGroup: 'voice_cloning_biometric',
    },
    {
      id: 'audio_spectral_analysis',
      methodName: 'Spectral & Frequency-Band Analysis',
      category: 'signal',
      status: 'completed',
      ran: true,
      resultSummary: `Spectral centroid ${audioProfile.spectralCentroidHz ?? 'N/A'} Hz; high-freq (>=4 kHz) share ${audioProfile.highFreqEnergyRatio !== null ? `${(audioProfile.highFreqEnergyRatio * 100).toFixed(1)}%` : 'N/A'}; quiet floor ${audioProfile.noiseFloorDb ?? 'N/A'} dB; dynamic range ${audioProfile.dynamicRangeDb} dB.`,
      rawSignalScore: spectralScore,
      signalPolarity: spectralPolarity,
      reliability: 'Low',
      reliabilityWeight: 0.36,
      calibrationStatus: 'Deterministic Check',
      applicability: '16 kHz mono PCM multi-window DFT & noise-floor analysis',
      evidenceStrength: spectralScore !== null ? 'Moderate' : 'Low',
      evidence: [
        `Multi-window spectral centroid: ${audioProfile.spectralCentroidHz ?? 'N/A'} Hz | Spectral flatness: ${audioProfile.spectralFlatness ?? 'N/A'}.`,
        `15th-percentile noise floor: ${audioProfile.noiseFloorDb ?? 'N/A'} dB | Silence ratio: ${(audioProfile.silenceRatio * 100).toFixed(1)}% | Dynamic range: ${audioProfile.dynamicRangeDb} dB.`,
        ...pcmDetectedCues.map((c) => `Detected acoustic signal: ${c}`),
        ...pcmUncertainSignals.map((u) => `Uncertain signal: ${u}`),
        ...pcmNaturalCues.map((n) => `Natural capture cue: ${n}`),
      ],
      limitations: [
        'Lossy MP3/AAC encoding naturally truncates upper frequency bands regardless of whether audio is real or synthetic.',
        'Studio noise gates (e.g., Krisp, RNNoise) can mimic near-digital-zero TTS silence floors.',
      ],
      toolUsed: 'FFmpeg PCM Decoder + TruthLens Multi-Window DFT Analyzer',
      correlationGroup: 'audio_signal_metrics',
    },
    aiAudio
      ? {
          id: 'prosody_speech_pattern',
          methodName: 'Prosody & Speech Cadence Analysis',
          category: 'signal',
          status: aiAudio.speechDetected ? 'completed' : 'not_applicable',
          ran: aiAudio.speechDetected,
          resultSummary: aiAudio.speechDetected
            ? aiAudio.prosodySummary
            : 'Not applicable (no speech detected).',
          rawSignalScore:
            aiAudio.speechDetected && typeof aiAudio.prosodyScore === 'number'
              ? Math.max(5, Math.min(94, aiAudio.prosodyScore))
              : null,
          signalPolarity:
            aiAudio.speechDetected && typeof aiAudio.prosodyScore === 'number'
              ? aiAudio.prosodyScore >= 62
                ? 'ai_indicator'
                : aiAudio.prosodyScore <= 38
                  ? 'natural_capture'
                  : 'neutral'
              : 'neutral',
          reliability: 'Experimental',
          reliabilityWeight: 0.54,
          calibrationStatus: 'Uncalibrated (Experimental)',
          applicability: 'Intonation, breathing, micro-pauses, and emotional rhythm',
          evidenceStrength: aiAudio.speechDetected ? 'Moderate' : 'Low',
          evidence: aiAudio.prosodyEvidence,
          limitations: [
            'Scripted narration, teleprompter reads, and trained broadcast speakers naturally exhibit regular cadence.',
          ],
          toolUsed: `Gemini Prosody Assessment (${aiModelUsed ?? GEMINI_FORENSIC_MODEL})`,
          correlationGroup: 'audio_prosody',
        }
      : {
          id: 'prosody_speech_pattern',
          methodName: 'Prosody & Speech Cadence Analysis',
          category: 'signal',
          status: 'failed',
          ran: false,
          resultSummary: `Failed (recoverable) — Gemini prosody review unavailable: ${aiAudioError}`,
          rawSignalScore: null,
          reliability: 'Experimental',
          calibrationStatus: 'Uncalibrated (Experimental)',
          applicability: 'Intonation, breathing, micro-pauses, and emotional rhythm',
          evidenceStrength: 'Low',
          evidence: ['Excluded from scoring; retry Gemini analysis when available.'],
          limitations: ['Upstream Gemini service unavailable.'],
          toolUsed: `Gemini Prosody Assessment (${GEMINI_FORENSIC_MODEL})`,
          correlationGroup: 'audio_prosody',
        },
    aiAudio
      ? {
          id: 'audio_artifact_analysis',
          methodName: 'Acoustic Artifact & Vocoder Distortion Inspection',
          category: 'signal',
          status: 'completed',
          ran: true,
          resultSummary: aiAudio.artifactSummary,
          rawSignalScore: Math.max(5, Math.min(94, aiAudio.artifactScore)),
          signalPolarity:
            aiAudio.artifactScore >= 62
              ? 'ai_indicator'
              : aiAudio.artifactScore <= 38
                ? 'natural_capture'
                : 'neutral',
          reliability: aiAudio.vocoderArtifactsDetected ? 'Moderate' : 'Experimental',
          reliabilityWeight: aiAudio.vocoderArtifactsDetected ? 0.64 : 0.48,
          calibrationStatus: 'Uncalibrated (Experimental)',
          applicability: 'Phase smearing, metallic vocoder buzz, abrupt noise-floor gating, and splice clicks',
          evidenceStrength: aiAudio.vocoderArtifactsDetected ? 'Moderate' : 'Low',
          evidence: aiAudio.artifactEvidence,
          limitations: [
            'Aggressive AI noise suppression (e.g., Krisp, RNNoise, Zoom) on authentic recordings can introduce similar gating and spectral artifacts.',
          ],
          toolUsed: `PCM Profile + Gemini Acoustic Artifact Review (${aiModelUsed ?? GEMINI_FORENSIC_MODEL})`,
          correlationGroup: 'audio_artifacts',
        }
      : {
          id: 'audio_artifact_analysis',
          methodName: 'Acoustic Artifact & Vocoder Distortion Inspection',
          category: 'signal',
          status: 'failed',
          ran: false,
          resultSummary: `Failed (recoverable) — Gemini acoustic artifact review unavailable: ${aiAudioError}`,
          rawSignalScore: null,
          reliability: 'Experimental',
          calibrationStatus: 'Uncalibrated (Experimental)',
          applicability: 'Phase smearing, metallic vocoder buzz, abrupt noise-floor gating, and splice clicks',
          evidenceStrength: 'Low',
          evidence: ['Local PCM waveform & RMS/ZCR segments completed; Gemini vocoder review excluded from scoring.'],
          limitations: ['Upstream Gemini service unavailable.'],
          toolUsed: `PCM Profile + Gemini Acoustic Artifact Review (${GEMINI_FORENSIC_MODEL})`,
          correlationGroup: 'audio_artifacts',
        },
    aiAudio
      ? {
          id: 'voice_consistency_analysis',
          methodName: 'Voice Timbre & Room-Tone Consistency',
          category: 'temporal',
          status: aiAudio.speechDetected ? 'completed' : 'not_applicable',
          ran: aiAudio.speechDetected,
          resultSummary: aiAudio.speechDetected
            ? aiAudio.voiceConsistencySummary
            : 'Not applicable (no speech detected).',
          rawSignalScore:
            aiAudio.speechDetected && typeof aiAudio.voiceConsistencyScore === 'number'
              ? Math.max(5, Math.min(94, aiAudio.voiceConsistencyScore))
              : null,
          signalPolarity:
            aiAudio.speechDetected && typeof aiAudio.voiceConsistencyScore === 'number'
              ? aiAudio.voiceConsistencyScore >= 62
                ? 'ai_indicator'
                : aiAudio.voiceConsistencyScore <= 38
                  ? 'natural_capture'
                  : 'neutral'
              : 'neutral',
          reliability: 'Experimental',
          reliabilityWeight: 0.48,
          calibrationStatus: 'Uncalibrated (Experimental)',
          applicability: 'Speaker identity continuity and background acoustic floor across segments',
          evidenceStrength: 'Low',
          evidence: aiAudio.voiceConsistencyEvidence,
          limitations: [
            'Edited podcasts or multi-take studio recordings legitimately splice room tone across takes.',
          ],
          toolUsed: `Gemini Audio Continuity Review (${aiModelUsed ?? GEMINI_FORENSIC_MODEL})`,
          correlationGroup: 'audio_continuity',
        }
      : {
          id: 'voice_consistency_analysis',
          methodName: 'Voice Timbre & Room-Tone Consistency',
          category: 'temporal',
          status: 'failed',
          ran: false,
          resultSummary: `Failed (recoverable) — Gemini continuity review unavailable: ${aiAudioError}`,
          rawSignalScore: null,
          reliability: 'Experimental',
          calibrationStatus: 'Uncalibrated (Experimental)',
          applicability: 'Speaker identity continuity and background acoustic floor across segments',
          evidenceStrength: 'Low',
          evidence: ['Excluded from scoring; retry Gemini analysis when available.'],
          limitations: ['Upstream Gemini service unavailable.'],
          toolUsed: `Gemini Audio Continuity Review (${GEMINI_FORENSIC_MODEL})`,
          correlationGroup: 'audio_continuity',
        },
    {
      id: 'audio_metadata_inspection',
      methodName: 'Audio Container & Encoder Metadata Inspection',
      category: 'metadata',
      status: 'completed',
      ran: true,
      resultSummary: encoderMatchesAi
        ? `Audio encoder tag ("${metadata.encoder}") matches a known AI audio synthesis platform.`
        : `Format: ${metadata.audioFormat || 'Unknown'}, Sample Rate: ${metadata.sampleRate ?? 'Unknown'} Hz, Bitrate: ${metadata.bitrate ? `${Math.round(metadata.bitrate / 1000)} kbps` : 'Unknown'}.`,
      rawSignalScore: encoderMatchesAi ? 78 : null,
      signalPolarity: encoderMatchesAi ? 'ai_indicator' : 'neutral',
      reliability: encoderMatchesAi ? 'Moderate' : 'Low',
      reliabilityWeight: encoderMatchesAi ? 0.72 : 0.3,
      calibrationStatus: 'Deterministic Check',
      applicability: 'ID3, MP4/M4A atoms, RIFF/WAV headers',
      evidenceStrength: encoderMatchesAi ? 'Moderate' : 'Low',
      evidence: [
        `Encoder / Tool: ${metadata.encoder || 'Not present'}.`,
        `Channels: ${metadata.audioChannels ?? 'Unknown'} | Codec: ${metadata.codec || 'Unknown'}.`,
        `Metadata tags present: ${Object.keys(metadata.tags ?? {}).length}.`,
      ],
      limitations: [
        'Audio transcoding strips or overwrites original encoder headers; missing tags do not indicate AI generation.',
      ],
      toolUsed: 'music-metadata + FFprobe',
      correlationGroup: 'metadata_context',
    },
    provenance.synthIdDetector,
  ];

  return {
    detectors,
    watermarks: provenance.provenanceWatermarks,
    audioProfile,
    geminiStatus: aiAudio ? 'completed' : 'failed',
    geminiModelUsed: aiModelUsed,
    geminiFailureDetail: aiAudioError,
  };
}
