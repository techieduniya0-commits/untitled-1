import { Type, ThinkingLevel } from '@google/genai';
import type {
  DetectorResult,
  DocumentSegmentFinding,
  DocumentStats,
  ExtractedMetadata,
  WatermarkFinding,
} from '../../src/types/forensics.ts';
import {
  GEMINI_FORENSIC_MODEL,
  type GeminiRetryEvent,
  runStructuredGeminiAnalysisWithMeta,
} from '../geminiClient.ts';
import type { ProvenanceInspectionOutput } from '../provenanceVerification/index.ts';

interface GeminiDocumentForensicsResponse {
  aiTextScore: number;
  aiTextSummary: string;
  aiTextEvidence: string[];
  writingStyleConsistencyScore: number;
  writingStyleSummary: string;
  writingStyleEvidence: string[];
  repetitivePatternScore: number;
  repetitivePatternSummary: string;
  repetitivePatternEvidence: string[];
  formattingConsistencySummary: string;
  segmentFindings: Array<{
    segmentIndex: number;
    indicatorLevel: 'neutral' | 'notable' | 'elevated';
    reason: string;
  }>;
}

const DOCUMENT_FORENSICS_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    aiTextScore: { type: Type.INTEGER },
    aiTextSummary: { type: Type.STRING },
    aiTextEvidence: { type: Type.ARRAY, items: { type: Type.STRING } },
    writingStyleConsistencyScore: { type: Type.INTEGER },
    writingStyleSummary: { type: Type.STRING },
    writingStyleEvidence: { type: Type.ARRAY, items: { type: Type.STRING } },
    repetitivePatternScore: { type: Type.INTEGER },
    repetitivePatternSummary: { type: Type.STRING },
    repetitivePatternEvidence: { type: Type.ARRAY, items: { type: Type.STRING } },
    formattingConsistencySummary: { type: Type.STRING },
    segmentFindings: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          segmentIndex: { type: Type.INTEGER },
          indicatorLevel: { type: Type.STRING, description: 'neutral, notable, or elevated' },
          reason: { type: Type.STRING },
        },
        required: ['segmentIndex', 'indicatorLevel', 'reason'],
      },
    },
  },
  required: [
    'aiTextScore',
    'aiTextSummary',
    'aiTextEvidence',
    'writingStyleConsistencyScore',
    'writingStyleSummary',
    'writingStyleEvidence',
    'repetitivePatternScore',
    'repetitivePatternSummary',
    'repetitivePatternEvidence',
    'formattingConsistencySummary',
    'segmentFindings',
  ],
};

function computeStylometry(text: string): {
  stats: DocumentStats;
  segments: string[];
} {
  const cleaned = text.replace(/\r\n/g, '\n').trim();
  const paragraphs = cleaned
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const words = cleaned
    .toLowerCase()
    .replace(/[^a-z0-9'\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  const sentences = cleaned
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 3);

  const sentenceLengths = sentences.map((s) => s.split(/\s+/).filter(Boolean).length);
  const avgSentenceLength =
    sentenceLengths.length > 0
      ? Number((sentenceLengths.reduce((a, b) => a + b, 0) / sentenceLengths.length).toFixed(2))
      : 0;

  const variance =
    sentenceLengths.length > 1
      ? sentenceLengths.reduce((acc, l) => acc + (l - avgSentenceLength) ** 2, 0) /
        sentenceLengths.length
      : 0;
  const sentenceLengthStdDev = Number(Math.sqrt(variance).toFixed(2));

  // Coefficient of variation as burstiness index (higher = more varied human-like cadence; lower = uniform)
  const burstinessScore =
    avgSentenceLength > 0 ? Number((sentenceLengthStdDev / avgSentenceLength).toFixed(3)) : 0;

  const uniqueWords = new Set(words);
  const lexicalDiversity =
    words.length > 0 ? Number((uniqueWords.size / words.length).toFixed(3)) : 0;

  // Compute repeated 4-gram rate
  const ngrams = new Map<string, number>();
  let total4Grams = 0;
  for (let i = 0; i <= words.length - 4; i++) {
    const gram = `${words[i]} ${words[i + 1]} ${words[i + 2]} ${words[i + 3]}`;
    ngrams.set(gram, (ngrams.get(gram) ?? 0) + 1);
    total4Grams++;
  }
  let repeated4Grams = 0;
  for (const count of ngrams.values()) {
    if (count > 1) repeated4Grams += count - 1;
  }
  const repeatedNgramRate =
    total4Grams > 0 ? Number((repeated4Grams / total4Grams).toFixed(4)) : 0;

  // Slice into up to 8 readable segments for highlighted report display
  let rawSegments = paragraphs.slice(0, 8);
  if (rawSegments.length <= 1 && cleaned.length > 260) {
    rawSegments = [];
    const chunkSize = Math.ceil(Math.min(cleaned.length, 4000) / 5);
    for (let i = 0; i < Math.min(cleaned.length, 4000); i += chunkSize) {
      rawSegments.push(cleaned.slice(i, i + chunkSize).trim());
    }
  }

  return {
    stats: {
      sentenceCount: sentences.length,
      wordCount: words.length,
      avgSentenceLength,
      sentenceLengthStdDev,
      lexicalDiversity,
      repeatedNgramRate,
      burstinessScore,
      paragraphCount: paragraphs.length,
    },
    segments: rawSegments.map((s) => s.slice(0, 520)),
  };
}

export interface DocumentPipelineOutput {
  detectors: DetectorResult[];
  watermarks: WatermarkFinding[];
  documentSegments: DocumentSegmentFinding[];
  documentStats: DocumentStats;
  geminiStatus: 'completed' | 'failed' | 'not_run';
  geminiModelUsed: string | null;
  geminiFailureDetail: string | null;
}

export async function runDocumentDetectionPipeline(options: {
  extractedText: string;
  metadata: ExtractedMetadata;
  provenance: ProvenanceInspectionOutput;
  isPdf: boolean;
  onStageProgress?: (
    stageId: 'forensic_analysis' | 'ai_assessment',
    detail: string,
    statusOverride?: 'running' | 'retrying',
  ) => void;
}): Promise<DocumentPipelineOutput> {
  const { extractedText, metadata, provenance, isPdf, onStageProgress } = options;

  onStageProgress?.('forensic_analysis', 'Computing quantitative stylometry, sentence burstiness, n-gram repetition, and document structure.');
  const { stats, segments } = computeStylometry(extractedText);

  const hasEnoughText = stats.wordCount >= 25;

  let aiDoc: GeminiDocumentForensicsResponse | null = null;
  let aiModelUsed: string | null = null;
  let aiDocError: string | null = null;

  if (hasEnoughText) {
    onStageProgress?.('ai_assessment', 'Running Gemini linguistic pattern and writing-style consistency inspection.');
    const numberedSegments = segments
      .map((seg, i) => `[Segment ${i}]: ${seg}`)
      .join('\n\n');

    try {
      const res = await runStructuredGeminiAnalysisWithMeta<GeminiDocumentForensicsResponse>({
        parts: [
          {
            text: [
              'Perform a cautious forensic linguistic review of this document text for potential AI-generated or AI-assisted writing indicators.',
              'Measured deterministic stylometry:',
              `- Word count: ${stats.wordCount}, Sentence count: ${stats.sentenceCount}, Paragraphs: ${stats.paragraphCount}`,
              `- Avg sentence length: ${stats.avgSentenceLength} words (StdDev: ${stats.sentenceLengthStdDev}, Burstiness CV: ${stats.burstinessScore})`,
              `- Lexical diversity (TTR): ${stats.lexicalDiversity} | Repeated 4-gram rate: ${(stats.repeatedNgramRate * 100).toFixed(2)}%`,
              `- Document metadata: Title="${metadata.title ?? 'None'}", Author="${metadata.author ?? 'None'}", Creator="${metadata.creator ?? 'None'}", Producer="${metadata.producer ?? 'None'}"`,
              '',
              'Segments to inspect:',
              numberedSegments,
              '',
              'IMPORTANT LIMITATIONS TO RESPECT:',
              '- AI-text detectors have high false-positive rates on formal, technical, legal, and non-native English writing.',
              '- Keep scores conservative (avoid extremes unless overwhelmingly formulaic/synthetic).',
              '- Provide a segmentFindings entry for each segment index provided above.',
            ].join('\n'),
          },
        ],
        responseSchema: DOCUMENT_FORENSICS_SCHEMA,
        thinkingLevel: ThinkingLevel.LOW,
        timeoutMs: 28_000,
        onRetry: (evt: GeminiRetryEvent) => {
          onStageProgress?.(
            'ai_assessment',
            `Gemini linguistic review retrying (${evt.attempt}/${evt.totalAttempts} → ${evt.nextModel} in ${(evt.delayMs / 1000).toFixed(1)}s): ${evt.reason}`,
            'retrying',
          );
        },
      });
      aiDoc = res.data;
      aiModelUsed = res.modelUsed;
    } catch (err) {
      aiDocError = err instanceof Error ? err.message : 'Gemini linguistic review failed.';
    }
  }

  const segFindingMap = new Map(
    (aiDoc?.segmentFindings ?? []).map((sf) => [sf.segmentIndex, sf]),
  );

  const documentSegments: DocumentSegmentFinding[] = segments.map((excerpt, index) => {
    const f = segFindingMap.get(index);
    const level =
      f?.indicatorLevel === 'elevated' || f?.indicatorLevel === 'notable'
        ? f.indicatorLevel
        : 'neutral';
    return {
      index,
      excerpt,
      indicatorLevel: level,
      reason:
        f?.reason ||
        (aiDocError
          ? 'Passage extracted locally; Gemini linguistic review unavailable during this run (retry available).'
          : hasEnoughText
            ? 'No distinct synthetic phrasing anomalies noted in this passage.'
            : 'Document text is too short (<25 words) for reliable linguistic segment evaluation.'),
    };
  });

  const embeddedImageCount = metadata.embeddedImageCount ?? 0;

  const detectors: DetectorResult[] = [
    // 1. PDF/Document text extraction
    {
      id: 'document_text_extraction',
      methodName: isPdf ? 'PDF Text Extraction' : 'Document Text Extraction',
      category: 'metadata',
      status: 'completed',
      ran: true,
      resultSummary: hasEnoughText
        ? `Extracted ${stats.wordCount} words across ${stats.sentenceCount} sentences (${stats.paragraphCount} paragraphs).`
        : `Extracted only ${stats.wordCount} words — insufficient text volume for reliable linguistic classification.`,
      rawSignalScore: null,
      reliability: 'High',
      calibrationStatus: 'Deterministic Check',
      applicability: isPdf ? 'PDF text layer decoding' : 'DOCX/TXT text decoding',
      evidenceStrength: hasEnoughText ? 'Moderate' : 'Low',
      evidence: [
        `Word count: ${stats.wordCount} | Character count: ${metadata.characterCount ?? extractedText.length}.`,
        isPdf ? `PDF Page count: ${metadata.pageCount ?? 'Unknown'}.` : `Format: ${metadata.documentStructure}.`,
      ],
      limitations: [
        isPdf
          ? 'Scanned image-only PDFs without an OCR text layer yield minimal or zero extractable text.'
          : 'Plain text formats carry no author or revision metadata.',
      ],
      toolUsed: isPdf ? 'unpdf + pdf-lib' : metadata.extension === '.docx' ? 'mammoth DOCX parser' : 'UTF-8 Text Decoder',
      correlationGroup: 'doc_extraction',
    },
    // 2. Document metadata extraction
    {
      id: 'document_metadata_extraction',
      methodName: 'Document Metadata Inspection',
      category: 'metadata',
      status: 'completed',
      ran: true,
      resultSummary: metadata.metadataPresent
        ? `Metadata present — Creator: ${metadata.creator || 'N/A'}, Producer: ${metadata.producer || 'N/A'}, Author: ${metadata.author || 'N/A'}.`
        : 'No document author, creator, or producer metadata fields present.',
      rawSignalScore: null,
      reliability: 'Low',
      calibrationStatus: 'Deterministic Check',
      applicability: 'PDF Info dictionary / DOCX core properties',
      evidenceStrength: 'Low',
      evidence: [
        `Title: ${metadata.title || 'Not present'} | Author: ${metadata.author || 'Not present'}.`,
        `Creator: ${metadata.creator || 'Not present'} | Producer: ${metadata.producer || 'Not present'}.`,
        `Creation Date: ${metadata.creationDate || 'Not present'} | Modification Date: ${metadata.modificationDate || 'Not present'}.`,
      ],
      limitations: [
        'Document metadata reflects the export software (e.g., Word, Chrome, LaTeX), not whether the prose was human-written or AI-generated.',
      ],
      toolUsed: isPdf ? 'pdf-lib Metadata Parser' : 'Container Property Inspector',
      correlationGroup: 'metadata_context',
    },
    {
      id: 'ai_text_classification',
      methodName: 'AI-Text Linguistic Classification',
      category: 'ai_reasoning',
      status: !hasEnoughText ? 'unavailable' : aiDoc ? 'completed' : 'failed',
      ran: Boolean(hasEnoughText && aiDoc),
      resultSummary: !hasEnoughText
        ? 'Not performed — minimum 25 words required for linguistic AI-text evaluation.'
        : aiDoc
          ? aiDoc.aiTextSummary
          : `Failed (recoverable) — Gemini linguistic classification unavailable: ${aiDocError}`,
      rawSignalScore:
        hasEnoughText && aiDoc ? Math.max(8, Math.min(90, aiDoc.aiTextScore)) : null,
      reliability: 'Low',
      calibrationStatus: 'Uncalibrated (Experimental)',
      applicability: 'Prose passages >= 25 words',
      evidenceStrength: 'Low',
      evidence: aiDoc?.aiTextEvidence ?? [aiDocError || 'Insufficient text length.'],
      limitations: [
        'AI-text detectors have major known limitations and CANNOT establish authorship with certainty.',
        'Formal academic prose, technical documentation, translated text, and grammar-edited human writing frequently trigger false positives.',
        'Human-edited AI output or paraphrased AI text frequently evades detection.',
      ],
      toolUsed: `Gemini Linguistic Pattern Assessment (${aiModelUsed ?? GEMINI_FORENSIC_MODEL})`,
      correlationGroup: 'doc_linguistic_ai',
    },
    {
      id: 'writing_style_consistency',
      methodName: 'Writing-Style Consistency & Burstiness Analysis',
      category: 'linguistic',
      status: !hasEnoughText ? 'unavailable' : aiDoc ? 'completed' : 'partially_completed',
      ran: Boolean(hasEnoughText),
      resultSummary: !hasEnoughText
        ? 'Not performed — insufficient text length.'
        : aiDoc
          ? `${aiDoc.writingStyleSummary} (Sentence length avg ${stats.avgSentenceLength} words, burstiness CV ${stats.burstinessScore}).`
          : `Deterministic stylometry completed locally (avg ${stats.avgSentenceLength} words/sentence, burstiness CV ${stats.burstinessScore}, TTR ${stats.lexicalDiversity}); Gemini qualitative review unavailable (${aiDocError}).`,
      rawSignalScore:
        hasEnoughText && aiDoc ? Math.max(10, Math.min(88, aiDoc.writingStyleConsistencyScore)) : null,
      reliability: 'Low',
      calibrationStatus: aiDoc ? 'Uncalibrated (Experimental)' : 'Deterministic Check',
      applicability: 'Cross-paragraph voice shifts and sentence-length variance',
      evidenceStrength: 'Low',
      evidence: [
        `Average sentence length: ${stats.avgSentenceLength} words (StdDev: ${stats.sentenceLengthStdDev}, Burstiness CV: ${stats.burstinessScore}).`,
        `Type-Token lexical diversity: ${stats.lexicalDiversity}.`,
        ...(aiDoc?.writingStyleEvidence ?? []),
      ],
      limitations: [
        'Multi-author documents, templates, and edited reports naturally display mixed writing styles.',
      ],
      toolUsed: aiDoc
        ? `TruthLens Stylometry + Gemini (${aiModelUsed ?? GEMINI_FORENSIC_MODEL})`
        : 'TruthLens Deterministic Stylometry (Gemini unavailable)',
      correlationGroup: 'doc_linguistic_ai',
    },
    {
      id: 'repetitive_pattern_analysis',
      methodName: 'Repetitive Sentence & N-Gram Pattern Analysis',
      category: 'linguistic',
      status: !hasEnoughText ? 'unavailable' : aiDoc ? 'completed' : 'partially_completed',
      ran: Boolean(hasEnoughText),
      resultSummary: !hasEnoughText
        ? 'Not performed — insufficient text length.'
        : aiDoc
          ? `${aiDoc.repetitivePatternSummary} (4-gram repetition rate ${(stats.repeatedNgramRate * 100).toFixed(2)}%).`
          : `Deterministic 4-gram repetition measured locally (${(stats.repeatedNgramRate * 100).toFixed(2)}%); Gemini phrasing review unavailable (${aiDocError}).`,
      rawSignalScore:
        hasEnoughText && aiDoc ? Math.max(10, Math.min(88, aiDoc.repetitivePatternScore)) : null,
      reliability: 'Low',
      calibrationStatus: aiDoc ? 'Uncalibrated (Experimental)' : 'Deterministic Check',
      applicability: 'Structural phrasing cadence, transitional clichés, and 4-gram repetition',
      evidenceStrength: 'Low',
      evidence: [
        `Measured 4-gram phrase repetition rate: ${(stats.repeatedNgramRate * 100).toFixed(2)}%.`,
        ...(aiDoc?.repetitivePatternEvidence ?? []),
      ],
      limitations: [
        'Legal contracts, compliance policies, and technical specs intentionally repeat standardized phrases.',
      ],
      toolUsed: aiDoc
        ? `TruthLens N-Gram Counter + Gemini (${aiModelUsed ?? GEMINI_FORENSIC_MODEL})`
        : 'TruthLens N-Gram Counter (Gemini unavailable)',
      correlationGroup: 'doc_linguistic_ai',
    },
    // 6. Formatting consistency inspection
    {
      id: 'formatting_consistency_inspection',
      methodName: 'Formatting & Typography Consistency Inspection',
      category: 'metadata',
      status: 'completed',
      ran: true,
      resultSummary:
        aiDoc?.formattingConsistencySummary ||
        `Inspected document layout (${metadata.fonts?.length ?? 0} font declarations, ${stats.paragraphCount} paragraphs).`,
      rawSignalScore: null,
      reliability: 'Low',
      calibrationStatus: 'Deterministic Check',
      applicability: 'Paragraph structure, bullet symmetry, and declared PDF fonts',
      evidenceStrength: 'Low',
      evidence: [
        isPdf
          ? `Declared PDF fonts (${metadata.fonts?.length ?? 0}): ${(metadata.fonts ?? []).slice(0, 8).join(', ') || 'None detected'}.`
          : `Paragraph count: ${stats.paragraphCount}.`,
      ],
      limitations: [
        'Formatting consistency depends heavily on authoring templates and copy-paste behavior.',
      ],
      toolUsed: 'TruthLens Structural Parser',
      correlationGroup: 'doc_structure',
    },
    // 7. Embedded image extraction
    {
      id: 'embedded_image_extraction',
      methodName: 'Embedded Image Extraction',
      category: 'metadata',
      status: isPdf || metadata.extension === '.docx' ? 'completed' : 'not_applicable',
      ran: isPdf || metadata.extension === '.docx',
      resultSummary:
        embeddedImageCount > 0
          ? `Detected ${embeddedImageCount} embedded image object(s) declared inside container structure.`
          : 'No embedded raster image objects detected inside document container.',
      rawSignalScore: null,
      reliability: 'Moderate',
      calibrationStatus: 'Deterministic Check',
      applicability: 'PDF Image XObjects and DOCX word/media entries',
      evidenceStrength: 'Low',
      evidence: [
        `Embedded image object count: ${embeddedImageCount}.`,
      ],
      limitations: [
        'Vector graphics and inline SVG drawings are not counted as raster Image XObjects.',
      ],
      toolUsed: 'PDF XObject / DOCX Media Scanner',
      correlationGroup: 'doc_embedded_media',
    },
    // 8. Embedded image analysis (honest reporting if images exist vs none)
    {
      id: 'embedded_image_analysis',
      methodName: 'Embedded Image Forensic Analysis',
      category: 'visual',
      status: embeddedImageCount > 0 ? 'unavailable' : 'not_applicable',
      ran: false,
      resultSummary:
        embeddedImageCount > 0
          ? `Not performed — ${embeddedImageCount} embedded image(s) detected, but automatic compressed PDF stream image decoding (e.g., pdfimages/Poppler) is not integrated in this runtime. Upload embedded images directly to run full image forensics.`
          : 'Not applicable — no embedded raster images found in this document.',
      rawSignalScore: null,
      reliability: 'Moderate',
      calibrationStatus: 'Deterministic Check',
      applicability: 'Raster images extracted from PDFs/DOCX',
      evidenceStrength: 'Low',
      evidence: [
        embeddedImageCount > 0
          ? 'Detected embedded image streams; extract and upload individual images for dedicated pixel, ELA, and watermark forensics.'
          : 'Document contains text only.',
      ],
      limitations: [
        'Embedded PDF images using custom Flate/JBIG2/JPX filters require native Poppler/pdfimages extraction.',
      ],
      toolUsed: 'Not integrated (Poppler pdfimages unavailable)',
      correlationGroup: 'doc_embedded_media',
    },
    // 9. Document structural inspection
    {
      id: 'document_structural_inspection',
      methodName: 'Document Structural & Provenance Inspection',
      category: 'provenance',
      status: 'completed',
      ran: true,
      resultSummary: `${metadata.documentStructure ?? 'Document parsed cleanly'}. C2PA status: ${metadata.c2paStatus}.`,
      rawSignalScore: null,
      reliability: 'Moderate',
      calibrationStatus: 'Deterministic Check',
      applicability: 'Container integrity, script-dictionary safety scan, and C2PA header check',
      evidenceStrength: 'Low',
      evidence: [
        metadata.documentStructure ?? 'Standard document structure.',
        ...(metadata.warnings.length > 0 ? metadata.warnings : ['No malicious script or launch dictionaries detected.']),
      ],
      limitations: [
        'Structural integrity checks verify container safety and provenance markers, not prose authorship.',
      ],
      toolUsed: 'TruthLens Document Structural Inspector',
      correlationGroup: 'doc_structure',
    },
  ];

  return {
    detectors,
    watermarks: provenance.provenanceWatermarks,
    documentSegments,
    documentStats: stats,
    geminiStatus: !hasEnoughText ? 'not_run' : aiDoc ? 'completed' : 'failed',
    geminiModelUsed: aiModelUsed,
    geminiFailureDetail: aiDocError,
  };
}
