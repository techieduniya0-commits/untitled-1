import type {
  Classification,
  DetectorResult,
  EvidencePolarity,
  EvidenceStrength,
  MethodContribution,
  ScoringBreakdown,
} from '../../src/types/forensics.ts';

const RELIABILITY_WEIGHTS: Record<DetectorResult['reliability'], number> = {
  High: 0.9,
  Moderate: 0.65,
  Experimental: 0.48,
  Low: 0.3,
};

function resolveSignalPolarity(detector: DetectorResult): EvidencePolarity {
  if (detector.signalPolarity) {
    return detector.signalPolarity;
  }
  if (detector.rawSignalScore === null || !Number.isFinite(detector.rawSignalScore)) {
    return 'neutral';
  }
  if (detector.rawSignalScore >= 60) {
    return 'ai_indicator';
  }
  if (detector.rawSignalScore <= 38) {
    return 'natural_capture';
  }
  return 'neutral';
}

function resolveProviderGroup(detector: DetectorResult): string {
  if (detector.providerGroup) {
    return detector.providerGroup;
  }
  const toolLower = detector.toolUsed.toLowerCase();
  if (detector.category === 'provenance') return 'provenance';
  if (detector.category === 'watermark') return 'watermark';
  if (detector.category === 'metadata') return 'deterministic_metadata';
  if (toolLower.includes('gemini')) return 'gemini_multimodal';
  return 'deterministic_signal';
}

export function aggregateForensicEvidence(detectors: DetectorResult[]): ScoringBreakdown {
  const completed = detectors.filter(
    (d) =>
      (d.status === 'completed' ||
        d.status === 'partially_implemented' ||
        d.status === 'partially_completed') &&
      d.ran,
  );
  const unavailable = detectors.filter((d) => d.status === 'unavailable');
  const failed = detectors.filter((d) => d.status === 'failed');
  const applicableTotal = detectors.filter(
    (d) => d.status !== 'not_applicable' && d.status !== 'skipped',
  ).length;
  const completenessPercent =
    applicableTotal > 0 ? Math.round((completed.length / applicableTotal) * 100) : 0;

  // Separate evidence into 3 transparent buckets: AI-supporting, natural-capture, and neutral/informational
  const evidenceSupportingAi: string[] = [];
  const evidenceSupportingNaturalCapture: string[] = [];
  const neutralObservations: string[] = [];

  // Group scored detectors by correlationGroup so correlated methods decay (1.0, 0.5, 0.25...)
  const groups = new Map<string, DetectorResult[]>();
  const contributions: MethodContribution[] = [];

  for (const detector of detectors) {
    if (
      (detector.status !== 'completed' &&
        detector.status !== 'partially_implemented' &&
        detector.status !== 'partially_completed') ||
      !detector.ran
    ) {
      contributions.push({
        methodName: detector.methodName,
        rawScore: null,
        weightApplied: 0,
        correlationGroup: detector.correlationGroup,
        status: detector.status,
        reliability: detector.reliability,
        signalPolarity: 'neutral',
        reason:
          detector.status === 'unavailable'
            ? 'Excluded — detector unavailable in current server runtime.'
            : detector.status === 'failed'
              ? 'Excluded — detector failed during processing (never treated as evidence of AI generation).'
              : 'Excluded — not applicable or skipped for this specimen.',
      });
      continue;
    }

    const polarity = resolveSignalPolarity(detector);

    if (detector.rawSignalScore === null || !Number.isFinite(detector.rawSignalScore)) {
      if (polarity === 'natural_capture') {
        evidenceSupportingNaturalCapture.push(`[${detector.methodName}] ${detector.resultSummary}`);
      } else {
        neutralObservations.push(`[${detector.methodName}] ${detector.resultSummary}`);
      }

      contributions.push({
        methodName: detector.methodName,
        rawScore: null,
        weightApplied: 0,
        correlationGroup: detector.correlationGroup,
        status: detector.status,
        reliability: detector.reliability,
        signalPolarity: polarity,
        reason:
          detector.status === 'partially_completed'
            ? 'Partial deterministic telemetry completed — AI-scored portion failed and was excluded.'
            : polarity === 'natural_capture'
              ? 'Contextual natural-capture metadata/telemetry (informational — does not override visual inspection).'
              : 'Neutral/informational forensic telemetry — provides context without inflating AI score.',
      });
      continue;
    }

    if (polarity === 'ai_indicator') {
      evidenceSupportingAi.push(
        `[${detector.methodName} · ${detector.rawSignalScore}/100] ${detector.resultSummary}`,
      );
    } else if (polarity === 'natural_capture') {
      evidenceSupportingNaturalCapture.push(
        `[${detector.methodName} · ${detector.rawSignalScore}/100] ${detector.resultSummary}`,
      );
    } else {
      neutralObservations.push(
        `[${detector.methodName} · ${detector.rawSignalScore}/100] ${detector.resultSummary}`,
      );
    }

    const list = groups.get(detector.correlationGroup) ?? [];
    list.push(detector);
    groups.set(detector.correlationGroup, list);
  }

  let weightedSum = 0;
  let totalWeight = 0;
  const groupScores: Array<{
    group: string;
    score: number;
    weight: number;
    names: string[];
    providers: Set<string>;
    polarity: EvidencePolarity;
  }> = [];
  const activeReliabilityWeights: number[] = [];
  const activeProviders = new Set<string>();

  for (const [groupName, members] of groups.entries()) {
    // Sort highest reliability first inside each correlation group, then halve each subsequent correlated member's weight (1, 0.5, 0.25...)
    const sorted = [...members].sort((a, b) => {
      const wa = a.reliabilityWeight ?? RELIABILITY_WEIGHTS[a.reliability] ?? 0.5;
      const wb = b.reliabilityWeight ?? RELIABILITY_WEIGHTS[b.reliability] ?? 0.5;
      return wb - wa;
    });

    let groupNum = 0;
    let groupWeightSum = 0;
    const groupProviders = new Set<string>();

    sorted.forEach((m, idx) => {
      const baseW = m.reliabilityWeight ?? RELIABILITY_WEIGHTS[m.reliability] ?? 0.5;
      const decay = 1 / Math.pow(2, idx); // 1.0, 0.5, 0.25...
      const effectiveW = Number((baseW * decay).toFixed(3));
      const score = Math.max(0, Math.min(100, m.rawSignalScore ?? 50));
      const polarity = resolveSignalPolarity(m);
      const provider = resolveProviderGroup(m);

      groupNum += score * effectiveW;
      groupWeightSum += effectiveW;
      activeReliabilityWeights.push(baseW);
      activeProviders.add(provider);
      groupProviders.add(provider);

      contributions.push({
        methodName: m.methodName,
        rawScore: m.rawSignalScore,
        weightApplied: Number(effectiveW.toFixed(2)),
        correlationGroup: groupName,
        status: m.status,
        reliability: m.reliability,
        signalPolarity: polarity,
        reason:
          idx === 0
            ? `Primary detector in group "${groupName}" (${polarity.replace('_', ' ')}, weight ${baseW.toFixed(2)}).`
            : `Correlated member #${idx + 1} in "${groupName}" — weight decayed (${Math.round(decay * 100)}%) to avoid double-counting.`,
      });
    });

    const groupScore = groupWeightSum > 0 ? groupNum / groupWeightSum : 50;
    const groupPolarity: EvidencePolarity =
      groupScore >= 60 ? 'ai_indicator' : groupScore <= 38 ? 'natural_capture' : 'neutral';

    weightedSum += groupNum;
    totalWeight += groupWeightSum;
    groupScores.push({
      group: groupName,
      score: groupScore,
      weight: groupWeightSum,
      names: sorted.map((m) => m.methodName),
      providers: groupProviders,
      polarity: groupPolarity,
    });
  }

  const rawAggregate = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 50;

  // Scored detector polarity tallies
  const scoredCompleted = completed.filter(
    (d) => d.rawSignalScore !== null && Number.isFinite(d.rawSignalScore),
  );
  const aiIndicatorDetectors = scoredCompleted.filter((d) => resolveSignalPolarity(d) === 'ai_indicator');
  const naturalCaptureDetectors = scoredCompleted.filter(
    (d) => resolveSignalPolarity(d) === 'natural_capture',
  );

  // Detect conflicting findings across independent groups AND large intra-pipeline divergence
  const conflictingFindings: string[] = [];
  const disagreementReasons: string[] = [];

  const highGroups = groupScores.filter((g) => g.score >= 65);
  const lowGroups = groupScores.filter((g) => g.score <= 36);

  if (highGroups.length > 0 && lowGroups.length > 0) {
    conflictingFindings.push(
      `Conflicting indicators observed: ${highGroups
        .map((g) => `${g.names[0]} (${Math.round(g.score)}/100)`)
        .join(', ')} indicated elevated AI/manipulation likelihood, whereas ${lowGroups
        .map((g) => `${g.names[0]} (${Math.round(g.score)}/100)`)
        .join(', ')} aligned with natural capture.`,
    );
    disagreementReasons.push(
      `Cross-group divergence (${Math.round(highGroups[0].score)}/100 vs ${Math.round(lowGroups[0].score)}/100): one forensic dimension flagged potential synthesis/manipulation artifacts while another observed organic capture characteristics. Compression, re-encoding, smartphone computational processing (HDR/EIS/beautification), or partial editing (such as face-swapping on real footage) commonly causes detectors to disagree.`,
    );
  } else if (scoredCompleted.length >= 2) {
    const scores = scoredCompleted.map((d) => d.rawSignalScore as number);
    const maxScore = Math.max(...scores);
    const minScore = Math.min(...scores);
    if (maxScore >= 66 && minScore <= 34 && maxScore - minScore >= 34) {
      const highDet = scoredCompleted.find((d) => d.rawSignalScore === maxScore)!;
      const lowDet = scoredCompleted.find((d) => d.rawSignalScore === minScore)!;
      conflictingFindings.push(
        `Internal detector divergence: ${highDet.methodName} (${maxScore}/100) flagged elevated synthetic risk while ${lowDet.methodName} (${minScore}/100) appeared consistent with natural capture.`,
      );
      disagreementReasons.push(
        `Different visual/signal facets disagreed by ${maxScore - minScore} points (${highDet.methodName} vs ${lowDet.methodName}). Localized manipulation, heavy transcoding, or ambiguous lighting can trigger one sub-detector while other traits remain natural.`,
      );
    }
  }

  // Provenance & high-signal corroborators
  const visibleAiWatermark = completed.find(
    (d) =>
      d.id === 'visible_watermark_detection' &&
      d.rawSignalScore !== null &&
      d.rawSignalScore >= 74 &&
      d.evidenceStrength === 'Strong',
  );
  const c2paAiClaim = completed.find(
    (d) => d.id === 'c2pa_provenance' && d.rawSignalScore !== null && d.rawSignalScore >= 75,
  );
  const manipulationIndicator = completed.find(
    (d) =>
      (d.id.includes('manipulation') ||
        d.id.includes('compositing') ||
        d.id.includes('double_jpeg') ||
        d.id === 'facial_landmark_analysis') &&
      d.rawSignalScore !== null &&
      d.rawSignalScore >= 65 &&
      (d.id !== 'facial_landmark_analysis' ||
        d.resultSummary.toLowerCase().includes('swap') ||
        d.resultSummary.toLowerCase().includes('deepfake') ||
        d.resultSummary.toLowerCase().includes('seam') ||
        d.resultSummary.toLowerCase().includes('blend')),
  );

  // Check if camera metadata / natural capture context conflicts with an uncorroborated moderate visual AI flag
  const cameraMetadataNatural = completed.find(
    (d) => d.id === 'video_metadata_inspection' && resolveSignalPolarity(d) === 'natural_capture',
  );
  if (
    cameraMetadataNatural &&
    highGroups.length > 0 &&
    !visibleAiWatermark &&
    !c2paAiClaim &&
    highGroups.every((g) => g.score < 82)
  ) {
    disagreementReasons.push(
      'Container metadata contains native smartphone/camera recording signatures, while experimental visual analysis noted moderate anomaly cues. Native device tags can be preserved during real capture (or copied via re-muxing), so manual review is advised.',
    );
  }

  let aiLikelihoodScore = rawAggregate;
  const aiGroups = groupScores.filter((g) => g.polarity === 'ai_indicator');
  const naturalGroups = groupScores.filter((g) => g.polarity === 'natural_capture');

  if (totalWeight === 0) {
    aiLikelihoodScore = 50;
  } else if (aiGroups.length === 0 && naturalGroups.length === 0 && !visibleAiWatermark && !c2paAiClaim) {
    // Purely neutral/inconclusive signals (39..59): dampen tightly around 50 so neutral noise never becomes a false positive
    aiLikelihoodScore = Math.round(rawAggregate * 0.4 + 50 * 0.6);
  } else if (conflictingFindings.length > 0 && !visibleAiWatermark && !c2paAiClaim) {
    if (manipulationIndicator && (manipulationIndicator.rawSignalScore ?? 0) >= 70) {
      // Localized manipulation (e.g., face-swap on genuine camera background) naturally diverges from background detectors
      aiLikelihoodScore = Math.max(62, Math.round(rawAggregate * 0.85 + 50 * 0.15));
    } else {
      // Unexplained conflict dampens score toward uncertainty (50) rather than forcing an extreme verdict
      aiLikelihoodScore = Math.round(rawAggregate * 0.72 + 50 * 0.28);
    }
  } else if (groupScores.length === 1 && scoredCompleted.length === 1 && !visibleAiWatermark && !c2paAiClaim) {
    // Single isolated scored detector: apply shrinkage toward 50 to avoid overconfident extremes
    aiLikelihoodScore = Math.round(rawAggregate * 0.68 + 50 * 0.32);
  }

  const isAudioPipeline = detectors.some(
    (d) => d.id === 'ai_speech_classification' || d.id === 'audio_spectral_analysis',
  );
  const audioAiGroups = isAudioPipeline ? groupScores.filter((g) => g.polarity === 'ai_indicator') : [];
  const audioEncoderAiMatch = isAudioPipeline && completed.some(
    (d) => d.id === 'audio_metadata_inspection' && (d.rawSignalScore ?? 0) >= 72,
  );
  let audioSingleIndicatorCapped = false;
  let audioMultiIndicatorBoost = 0;

  if (isAudioPipeline && !visibleAiWatermark && !c2paAiClaim) {
    if (audioAiGroups.length === 1 && aiIndicatorDetectors.length === 1 && !audioEncoderAiMatch) {
      // Never automatically label audio as AI-generated based on a single isolated indicator
      if (aiLikelihoodScore > 58) {
        aiLikelihoodScore = 58;
        audioSingleIndicatorCapped = true;
      }
    } else if (
      aiIndicatorDetectors.length >= 2 &&
      audioAiGroups.length >= 2 &&
      conflictingFindings.length === 0
    ) {
      // Multiple independent synthetic speech indicators corroborate AI-generated speech -> increase confidence proportionally
      audioMultiIndicatorBoost = aiIndicatorDetectors.length >= 3 ? 10 : 6;
      aiLikelihoodScore = Math.min(94, aiLikelihoodScore + audioMultiIndicatorBoost);
    }
  }

  // Only strong watermark or provenance evidence can elevate floor — never claiming 100%
  if (visibleAiWatermark && aiLikelihoodScore < 74) {
    aiLikelihoodScore = Math.min(94, Math.max(aiLikelihoodScore, 78));
  }
  if (c2paAiClaim && aiLikelihoodScore < 76) {
    aiLikelihoodScore = Math.min(95, Math.max(aiLikelihoodScore, 80));
  }

  aiLikelihoodScore = Math.max(4, Math.min(96, aiLikelihoodScore));

  // Overall reliability based on average reliability of contributing detectors AND provider diversity
  const avgRel =
    activeReliabilityWeights.length > 0
      ? activeReliabilityWeights.reduce((a, b) => a + b, 0) / activeReliabilityWeights.length
      : 0.3;
  const providerCount = activeProviders.size;

  const overallReliability: 'Low' | 'Moderate' | 'High' =
    totalWeight === 0
      ? 'Low'
      : avgRel >= 0.72 && completenessPercent >= 70 && failed.length === 0 && providerCount >= 2
        ? 'High'
        : avgRel >= 0.45 && completenessPercent >= 45
          ? 'Moderate'
          : 'Low';

  // Separate Evidence Strength
  let evidenceStrength: EvidenceStrength = 'Low';
  const independentCount = groupScores.length;
  const strongSignals = completed.filter((d) => d.evidenceStrength === 'Strong').length;

  if (totalWeight === 0) {
    evidenceStrength = 'Low';
  } else if (
    (visibleAiWatermark ||
      c2paAiClaim ||
      (strongSignals >= 2 && providerCount >= 2) ||
      (isAudioPipeline && aiIndicatorDetectors.length >= 3 && audioAiGroups.length >= 3 && conflictingFindings.length === 0)) &&
    independentCount >= 2 &&
    conflictingFindings.length === 0
  ) {
    evidenceStrength = 'Strong';
  } else if (
    (independentCount >= 2 || scoredCompleted.length >= 2) &&
    conflictingFindings.length === 0 &&
    (aiIndicatorDetectors.length >= 2 || naturalCaptureDetectors.length >= 2 || strongSignals >= 1)
  ) {
    evidenceStrength = 'Moderate';
  } else {
    evidenceStrength = 'Low';
  }

  // Recalibrated classification logic: strict anti-false-positive discipline
  let classification: Classification = 'Inconclusive';
  const hasDocumentPipeline = completed.some(
    (d) =>
      d.category === 'linguistic' &&
      !isAudioPipeline &&
      (d.id.includes('stylometry') ||
        d.id.includes('burstiness') ||
        d.id.includes('ngram') ||
        d.id.includes('linguistic') ||
        d.id.includes('document')),
  );
  const hasStrongProvenanceAi = Boolean(visibleAiWatermark || c2paAiClaim);

  if (totalWeight === 0) {
    classification = 'Inconclusive';
  } else if (audioSingleIndicatorCapped) {
    classification = 'Inconclusive';
  } else if (
    conflictingFindings.length > 0 &&
    !hasStrongProvenanceAi &&
    !manipulationIndicator &&
    Math.abs(aiLikelihoodScore - 50) <= 22
  ) {
    classification = 'Inconclusive';
  } else if (
    manipulationIndicator &&
    aiLikelihoodScore >= 56 &&
    aiLikelihoodScore < 76 &&
    !hasStrongProvenanceAi
  ) {
    classification = 'Potentially manipulated';
  } else if (
    aiLikelihoodScore >= 70 &&
    (hasStrongProvenanceAi ||
      (aiIndicatorDetectors.length >= 2 && conflictingFindings.length === 0) ||
      (!isAudioPipeline && aiLikelihoodScore >= 80 && conflictingFindings.length === 0))
  ) {
    classification =
      hasDocumentPipeline && evidenceStrength !== 'Strong'
        ? 'Potentially AI-assisted'
        : 'Likely AI-generated';
  } else if (
    aiLikelihoodScore >= 58 &&
    aiIndicatorDetectors.length >= 1 &&
    (conflictingFindings.length === 0 || aiLikelihoodScore >= 64)
  ) {
    classification = 'Potentially AI-assisted';
  } else if (
    aiLikelihoodScore <= 36 &&
    conflictingFindings.length === 0 &&
    aiIndicatorDetectors.length === 0 &&
    (naturalCaptureDetectors.length >= 2 ||
      (naturalCaptureDetectors.length >= 1 && aiLikelihoodScore <= 28))
  ) {
    classification = 'Likely human-created';
  } else {
    classification = 'Inconclusive';
  }

  const scoreExplanation: string[] = [
    `Pipeline completeness: ${completenessPercent}% (${completed.length} of ${applicableTotal} applicable detectors ran; ${unavailable.length} unavailable and ${failed.length} failed excluded rather than defaulted to zero).`,
    `Aggregated ${groupScores.length} correlation group(s) across ${providerCount} signal provider(s) with exponential decay (100% → 50% → 25%) to prevent correlated double-counting.`,
    `Evidence polarity split: ${evidenceSupportingAi.length} AI-supporting indicator(s), ${evidenceSupportingNaturalCapture.length} natural-capture observation(s), and ${neutralObservations.length} neutral/informational observation(s).`,
  ];

  if (audioMultiIndicatorBoost > 0) {
    scoreExplanation.push(
      `Multi-indicator synthetic speech corroboration: ${aiIndicatorDetectors.length} independent audio indicators aligned without conflict, increasing AI-generated speech confidence by +${audioMultiIndicatorBoost} points.`,
    );
  }
  if (audioSingleIndicatorCapped) {
    scoreExplanation.push(
      'Single-indicator audio safeguard applied: only one audio cue was elevated without corroboration, so the score was capped at 58/100 (Inconclusive) rather than automatically labeling the recording as AI-generated.',
    );
  }
  if (failed.length > 0) {
    scoreExplanation.push(
      `${failed.length} detector(s) failed due to temporary upstream unavailability and were excluded from scoring (API failures are never treated as evidence of AI generation).`,
    );
  }
  if (totalWeight === 0) {
    scoreExplanation.push(
      'No scored detectors produced a numeric AI-likelihood signal (available checks were informational telemetry only); classification defaulted to Inconclusive at neutral 50/100.',
    );
  }
  if (aiGroups.length === 0 && naturalGroups.length === 0 && totalWeight > 0 && !hasStrongProvenanceAi) {
    scoreExplanation.push(
      'All numeric detector outputs fell in the neutral/ambiguous band (39–59/100) with no concrete synthetic defects; score was damped toward 50/100 (Inconclusive) to prevent false positives.',
    );
  }
  if (visibleAiWatermark) {
    scoreExplanation.push(
      `Strong visible watermark evidence (${visibleAiWatermark.resultSummary}) contributed high provenance weight.`,
    );
  }
  if (c2paAiClaim) {
    scoreExplanation.push(
      'Embedded C2PA / XMP algorithmic creation assertions contributed strong provenance weight.',
    );
  }
  if (conflictingFindings.length > 0) {
    scoreExplanation.push(
      'Conflicting detector signals moderated the final estimate toward uncertainty and reduced evidence strength.',
    );
  }
  scoreExplanation.push(
    'Absence of AI watermarks or C2PA metadata is recorded as neutral context only and is never treated as proof of authenticity or AI generation.',
  );
  scoreExplanation.push(
    'This composite score is an Experimental AI-Likelihood Estimate, not definitive proof of authorship.',
  );

  return {
    aiLikelihoodScore,
    isExperimental: true,
    calibrationLabel: 'Experimental AI-Likelihood Estimate',
    evidenceStrength,
    classification,
    completenessPercent,
    overallReliability,
    methodsPerformedCount: completed.length,
    methodsUnavailableCount: unavailable.length,
    methodsFailedCount: failed.length,
    conflictingFindings,
    disagreementReasons,
    evidenceSupportingAi,
    evidenceSupportingNaturalCapture,
    neutralObservations,
    scoreExplanation,
    methodContributions: contributions,
  };
}
