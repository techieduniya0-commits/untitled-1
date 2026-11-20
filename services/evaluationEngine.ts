import type {
  AnalysisRecord,
  BenchmarkConditionMetrics,
  BenchmarkEvaluationReport,
  DatasetRecord,
} from '../src/types/forensics.ts';

function isPositiveGroundTruth(label: DatasetRecord['ground_truth_label']): boolean {
  return label === 'AI_GENERATED' || label === 'AI_ASSISTED' || label === 'MANIPULATED';
}

function roundMetric(value: number | null, digits = 4): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}

/**
 * Exact ROC-AUC via pairwise concordance / trapezoidal integration over sorted predicted scores.
 * Returns null if either positive or negative class has 0 samples.
 */
function computeRocAuc(samples: Array<{ score: number; positive: boolean }>): number | null {
  const positives = samples.filter((s) => s.positive);
  const negatives = samples.filter((s) => !s.positive);
  if (positives.length === 0 || negatives.length === 0) {
    return null;
  }
  let concordant = 0;
  let ties = 0;
  for (const p of positives) {
    for (const n of negatives) {
      if (p.score > n.score) concordant += 1;
      else if (p.score === n.score) ties += 1;
    }
  }
  return (concordant + 0.5 * ties) / (positives.length * negatives.length);
}

/**
 * Evaluates detection performance (FPR, FNR, Precision, Recall, F1, Accuracy, ROC-AUC)
 * strictly on non-seed, labeled dataset records that have a real predicted score
 * (either stored on the record or linked to a completed TruthLens analysis).
 * Never fabricates metrics when eligible samples = 0.
 */
export function evaluateBenchmarkDataset(
  records: DatasetRecord[],
  analyses: AnalysisRecord[],
  threshold = 60,
): BenchmarkEvaluationReport {
  const clampedThreshold = Math.max(30, Math.min(85, Math.round(threshold)));
  const analysisById = new Map<string, AnalysisRecord>();
  const analysisByHash = new Map<string, AnalysisRecord>();

  for (const a of analyses) {
    if ((a.status === 'completed' || a.status === 'partially_completed') && a.scoring) {
      analysisById.set(a.id, a);
      if (a.fileHash && !analysisByHash.has(a.fileHash)) {
        analysisByHash.set(a.fileHash, a);
      }
    }
  }

  interface EvaluatedSample {
    sampleId: string;
    positive: boolean;
    score: number;
    predictedPositive: boolean;
    inconclusive: boolean;
    condition: string;
    split: DatasetRecord['split'];
  }

  const evaluated: EvaluatedSample[] = [];
  let nonSeedTotal = 0;
  let unlinkedLabeledCount = 0;

  for (const rec of records) {
    if (rec.is_illustrative_seed) continue;
    nonSeedTotal += 1;
    if (rec.ground_truth_label === 'UNKNOWN') continue;

    // Resolve real predicted score from record or linked completed analysis
    let score: number | null =
      typeof rec.predicted_score === 'number' && Number.isFinite(rec.predicted_score)
        ? rec.predicted_score
        : null;
    let predictedClass = rec.predicted_classification || '';

    if (score === null) {
      const linked =
        (rec.linked_analysis_id ? analysisById.get(rec.linked_analysis_id) : undefined) ??
        (rec.file_hash ? analysisByHash.get(rec.file_hash) : undefined);
      if (linked?.scoring) {
        score = linked.scoring.aiLikelihoodScore;
        predictedClass = linked.scoring.classification;
      }
    }

    if (score === null) {
      unlinkedLabeledCount += 1;
      continue;
    }

    const positive = isPositiveGroundTruth(rec.ground_truth_label);
    const predictedPositive = score >= clampedThreshold;
    const inconclusive =
      predictedClass === 'Inconclusive' || (score > 36 && score < clampedThreshold);
    const condition =
      rec.recording_condition?.trim() ||
      (rec.media_type === 'video'
        ? positive
          ? 'Video — AI / Manipulated (unspecified)'
          : 'Video — Real Human (unspecified)'
        : `${rec.media_type} (${positive ? 'AI/Manipulated' : 'Real'})`);

    evaluated.push({
      sampleId: rec.sample_id,
      positive,
      score,
      predictedPositive,
      inconclusive,
      condition,
      split: rec.split,
    });
  }

  if (evaluated.length === 0) {
    return {
      evaluatedAt: new Date().toISOString(),
      thresholdUsed: clampedThreshold,
      eligibleCount: 0,
      nonSeedTotal,
      unlinkedLabeledCount,
      positiveCount: 0,
      negativeCount: 0,
      confusionMatrix: { tp: 0, fp: 0, tn: 0, fn: 0 },
      accuracy: null,
      precision: null,
      recall: null,
      f1: null,
      fpr: null,
      fnr: null,
      rocAuc: null,
      inconclusiveRate: null,
      meanRealScore: null,
      meanAiScore: null,
      byCondition: [],
      calibrationNotes: [
        'No non-seed labeled records with recorded or linked TruthLens prediction scores are available yet.',
        'Upload and analyse real specimens, click "Log to Dataset", assign verified ground truth (REAL / AI_GENERATED / MANIPULATED), or import a scored evaluation CSV to compute live FPR, FNR, Precision, Recall, Accuracy, and ROC-AUC.',
      ],
    };
  }

  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  let inconclusiveCount = 0;

  const realScores: number[] = [];
  const aiScores: number[] = [];
  const conditionMap = new Map<string, EvaluatedSample[]>();

  for (const s of evaluated) {
    if (s.positive) {
      aiScores.push(s.score);
      if (s.predictedPositive) tp += 1;
      else fn += 1;
    } else {
      realScores.push(s.score);
      if (s.predictedPositive) fp += 1;
      else tn += 1;
    }
    if (s.inconclusive) inconclusiveCount += 1;

    const list = conditionMap.get(s.condition) ?? [];
    list.push(s);
    conditionMap.set(s.condition, list);
  }

  const total = evaluated.length;
  const accuracy = (tp + tn) / total;
  const precision = tp + fp > 0 ? tp / (tp + fp) : null;
  const recall = tp + fn > 0 ? tp / (tp + fn) : null;
  const f1 =
    precision !== null && recall !== null && precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : null;
  const fpr = fp + tn > 0 ? fp / (fp + tn) : null;
  const fnr = fn + tp > 0 ? fn / (fn + tp) : null;
  const rocAuc = computeRocAuc(evaluated.map((s) => ({ score: s.score, positive: s.positive })));
  const inconclusiveRate = inconclusiveCount / total;
  const meanRealScore =
    realScores.length > 0
      ? Math.round((realScores.reduce((a, b) => a + b, 0) / realScores.length) * 10) / 10
      : null;
  const meanAiScore =
    aiScores.length > 0
      ? Math.round((aiScores.reduce((a, b) => a + b, 0) / aiScores.length) * 10) / 10
      : null;

  const byCondition: BenchmarkConditionMetrics[] = Array.from(conditionMap.entries())
    .map(([condition, items]) => {
      const cPos = items.filter((i) => i.positive);
      const cNeg = items.filter((i) => !i.positive);
      const cFp = cNeg.filter((i) => i.predictedPositive).length;
      const cFn = cPos.filter((i) => !i.predictedPositive).length;
      const cCorrect = items.filter((i) => i.predictedPositive === i.positive).length;
      const avgScore =
        Math.round((items.reduce((acc, i) => acc + i.score, 0) / items.length) * 10) / 10;
      return {
        condition,
        sampleCount: items.length,
        realCount: cNeg.length,
        aiCount: cPos.length,
        meanScore: avgScore,
        accuracy: roundMetric(cCorrect / items.length),
        fpr: cNeg.length > 0 ? roundMetric(cFp / cNeg.length) : null,
        fnr: cPos.length > 0 ? roundMetric(cFn / cPos.length) : null,
      };
    })
    .sort((a, b) => b.sampleCount - a.sampleCount);

  const calibrationNotes: string[] = [];
  if (fpr !== null && fpr > 0.1) {
    calibrationNotes.push(
      `Elevated false-positive rate (${(fpr * 100).toFixed(1)}%) on genuine human specimens at threshold ${clampedThreshold}. Review misclassified natural-capture videos or raise the operating threshold.`,
    );
  } else if (fpr !== null) {
    calibrationNotes.push(
      `False-positive rate on verified real specimens is ${(fpr * 100).toFixed(1)}% (${fp}/${fp + tn}) at threshold ${clampedThreshold}.`,
    );
  }
  if (fnr !== null && fnr > 0.2) {
    calibrationNotes.push(
      `False-negative rate is ${(fnr * 100).toFixed(1)}% (${fn}/${fn + tp}); heavily compressed or subtle AI clips may require additional specialized detectors.`,
    );
  }
  if (realScores.length === 0 || aiScores.length === 0) {
    calibrationNotes.push(
      'Both REAL and AI_GENERATED/MANIPULATED labeled samples are required to compute ROC-AUC and balanced precision/recall.',
    );
  }
  if (total < 20) {
    calibrationNotes.push(
      `Current evaluation covers ${total} sample(s). Collect at least 30+ balanced test-split specimens across smartphone, DSLR, social-media re-encode, and AI-generator sources for statistically reliable calibration.`,
    );
  }

  return {
    evaluatedAt: new Date().toISOString(),
    thresholdUsed: clampedThreshold,
    eligibleCount: total,
    nonSeedTotal,
    unlinkedLabeledCount,
    positiveCount: aiScores.length,
    negativeCount: realScores.length,
    confusionMatrix: { tp, fp, tn, fn },
    accuracy: roundMetric(accuracy),
    precision: roundMetric(precision),
    recall: roundMetric(recall),
    f1: roundMetric(f1),
    fpr: roundMetric(fpr),
    fnr: roundMetric(fnr),
    rocAuc: roundMetric(rocAuc),
    inconclusiveRate: roundMetric(inconclusiveRate),
    meanRealScore,
    meanAiScore,
    byCondition,
    calibrationNotes,
  };
}
