import type {
  AnalysisRecord,
  FollowUpQuestion,
  OriginalAnalysisSnapshot,
  ReanalysisChangeSummary,
  ScoringBreakdown,
  UserProvidedContext,
} from '../src/types/forensics.ts';

export interface SufficiencyAssessment {
  needsContext: boolean;
  reasons: string[];
  questions: FollowUpQuestion[];
}

export function buildOriginalSnapshot(analysis: AnalysisRecord): OriginalAnalysisSnapshot {
  const scoring = analysis.scoring;
  const failedCount = analysis.detectors.filter((d) => d.status === 'failed').length;
  return {
    capturedAt: new Date().toISOString(),
    status:
      analysis.status === 'processing' ? 'needs_context' : analysis.status,
    aiLikelihoodScore: scoring?.aiLikelihoodScore ?? 50,
    classification: scoring?.classification ?? 'Inconclusive',
    evidenceStrength: scoring?.evidenceStrength ?? 'Low',
    overallReliability: scoring?.overallReliability ?? 'Low',
    completenessPercent: scoring?.completenessPercent ?? 0,
    methodsPerformedCount: scoring?.methodsPerformedCount ?? 0,
    methodsFailedCount: scoring?.methodsFailedCount ?? failedCount,
    evidenceSupportingAi: [...(scoring?.evidenceSupportingAi ?? [])],
    evidenceSupportingNaturalCapture: [...(scoring?.evidenceSupportingNaturalCapture ?? [])],
    neutralObservations: [...(scoring?.neutralObservations ?? [])],
    conflictingFindings: [...(scoring?.conflictingFindings ?? [])],
    executiveSummary:
      analysis.geminiSummary?.executiveSummary ??
      `Initial automated inspection completed ${scoring?.methodsPerformedCount ?? 0} detector(s) with an experimental score of ${scoring?.aiLikelihoodScore ?? 50}/100 (${scoring?.classification ?? 'Inconclusive'}).`,
  };
}

export function evaluateEvidenceSufficiency(analysis: AnalysisRecord): SufficiencyAssessment {
  const scoring = analysis.scoring;
  const metadata = analysis.metadata;
  const reasons: string[] = [];
  const questions: FollowUpQuestion[] = [];

  if (!scoring) {
    reasons.push('Automated evidence aggregation did not produce a complete scoring breakdown.');
  }

  const failedDetectors = analysis.detectors.filter((d) => d.status === 'failed');
  const isIncompletePipeline =
    failedDetectors.length > 0 ||
    analysis.geminiStatus === 'failed' ||
    analysis.geminiStatus === 'partially_completed' ||
    Boolean(analysis.isPartialReport);

  const hasStrongEvidence = scoring?.evidenceStrength === 'Strong';
  const hasLowEvidence = !scoring || scoring.evidenceStrength === 'Low';
  const isInconclusive = !scoring || scoring.classification === 'Inconclusive';
  const hasConflicts = Boolean(scoring && scoring.conflictingFindings.length > 0);
  const missingMetadata = Boolean(metadata && !metadata.metadataPresent);
  const missingC2pa = !metadata || metadata.c2paStatus !== 'present_unverified';

  if (isIncompletePipeline) {
    reasons.push(
      `Automated multimodal analysis was incomplete (${failedDetectors.length} detector(s) failed or partially completed: ${analysis.geminiFailureDetail || 'upstream service interruption'}).`,
    );
    questions.push({
      id: 'q_incomplete_origin',
      category: 'incomplete_pipeline',
      question: `Some automated checks could not complete on the initial pass. What do you know about where this ${analysis.mediaType} came from or how it was produced?`,
      whyAsked:
        'TruthLens will retry the incomplete detectors alongside your context rather than issuing a premature partial report.',
      suggestedChoices: [
        'Recorded or created directly by me',
        'Received from another person or messaging app',
        'Downloaded from social media or a website',
        'Created or edited with software / AI tools',
        'I do not know the original source',
      ],
      placeholder: 'Share where you obtained this file or any details about its creation…',
    });
  }

  if (hasConflicts && scoring) {
    reasons.push(
      `Detectors produced conflicting signals (${scoring.conflictingFindings[0]}).`,
    );
    questions.push({
      id: 'q_conflicting_edits',
      category: 'conflicting_signals',
      question:
        'Our detectors observed conflicting signals across different checks. Has this file been edited, compressed, filtered, upscaled, or re-encoded?',
      whyAsked:
        'Compression, social-media re-encoding, HDR/beautification filters, or partial editing often explain why independent forensic checks disagree.',
      suggestedChoices: [
        'Original unedited file from camera / microphone',
        'Re-saved or downloaded via social media / WhatsApp / messaging',
        'Edited, trimmed, color-graded, or enhanced in an editor',
        'Partially generated or altered using AI tools',
        'Unknown / cannot verify editing history',
      ],
      placeholder: 'Describe any editing, re-encoding, filters, or tools applied to this file…',
    });
  }

  if (analysis.mediaType === 'audio') {
    const audioUncertain = analysis.audioProfile?.uncertainSignals ?? [];
    if (isInconclusive || hasLowEvidence || audioUncertain.length > 0) {
      if (audioUncertain.length > 0 && !reasons.some((r) => r.includes('audio'))) {
        reasons.push(
          `Audio analysis detected ${audioUncertain.length} uncertain acoustic signal(s) that require recording context to interpret accurately.`,
        );
      }
      questions.push({
        id: 'q_audio_recording_setup',
        category: 'audio_context',
        question:
          'How was this audio captured or processed (e.g., live microphone, phone voice memo, noise suppression like Krisp/Zoom, or text-to-speech software)?',
        whyAsked:
          'Aggressive noise gating, podcast compression, and conferencing filters can mimic near-digital-zero silence or spectral rolloff seen in synthetic speech.',
        suggestedChoices: [
          'Live phone or microphone recording (unprocessed)',
          'Studio / podcast recording with noise suppression or compression',
          'Recorded from a call, screen capture, or speaker playback',
          'Suspected AI voice / TTS / voice clone',
          'Unknown recording setup',
        ],
        placeholder: 'Describe the microphone, app, noise suppression, or suspected voice tool…',
      });
    }
  } else if (missingMetadata && !hasStrongEvidence) {
    reasons.push(
      'Essential file provenance and container/EXIF metadata are missing or were stripped prior to upload.',
    );
    questions.push({
      id: 'q_missing_metadata',
      category: 'missing_metadata',
      question:
        analysis.mediaType === 'image'
          ? 'Original camera EXIF/device metadata is absent. Was this image taken directly on a camera/phone, screenshotted, downloaded from social media, or exported from an app?'
          : analysis.mediaType === 'video'
            ? 'Camera/device container metadata is missing or generic. What device, camera app, or platform originally created or exported this video?'
            : 'Document authorship/creation metadata is missing or minimal. How was this document drafted or exported?',
      whyAsked:
        'Missing metadata is neutral on its own, so understanding transfer or export history helps contextualize why provenance tags are absent.',
      suggestedChoices:
        analysis.mediaType === 'image' || analysis.mediaType === 'video'
          ? [
              'Direct camera / smartphone capture',
              'Downloaded from social media / messaging app (strips metadata)',
              'Screenshot or screen recording',
              'Exported from an editing or AI generation platform',
              'Unknown source',
            ]
          : [
              'Written manually from scratch',
              'Human draft edited with grammar/AI tools',
              'Generated or heavily assisted by an AI writing tool',
              'Received from a third party (origin unknown)',
            ],
      placeholder: 'Provide any known device, app, export workflow, or transfer path…',
    });
  }

  if ((isInconclusive || hasLowEvidence) && questions.length < 2) {
    if (!reasons.some((r) => r.includes('Inconclusive') || r.includes('Low'))) {
      reasons.push(
        `Available automated evidence is currently ${scoring?.classification ?? 'Inconclusive'} with ${scoring?.evidenceStrength ?? 'Low'} evidence strength${missingC2pa ? ' and no C2PA provenance manifest' : ''}.`,
      );
    }
    questions.push({
      id: 'q_capture_context',
      category: 'capture_origin',
      question:
        'What is the broader context behind this file (who shared it, what claim accompanies it, and why are you verifying it)?',
      whyAsked:
        'Knowing the verification context helps TruthLens highlight the most relevant technical checks and practical next steps without treating opinions as proof.',
      suggestedChoices: [
        'Verifying authenticity of content found online',
        'Checking a file sent to me by someone else',
        'Testing or auditing my own media',
        'Investigating suspected AI manipulation or impersonation',
        'Prefer not to say / general check',
      ],
      placeholder: 'Share relevant background, context, or what made you want to verify this file…',
    });
  }

  // Determine whether essential information is missing before showing a final report:
  // Trigger follow-up when pipeline is partial/incomplete, classification is Inconclusive,
  // evidence strength is Low, detectors conflict, or metadata is missing without Strong conclusive proof.
  const needsContext =
    isIncompletePipeline ||
    isInconclusive ||
    hasLowEvidence ||
    hasConflicts ||
    (missingMetadata && !hasStrongEvidence && (scoring?.completenessPercent ?? 0) < 85);

  return {
    needsContext,
    reasons,
    questions: questions.slice(0, 3),
  };
}

export function buildReanalysisChangeSummary(options: {
  original: OriginalAnalysisSnapshot;
  updatedScoring: ScoringBreakdown;
  userContext: UserProvidedContext;
  detectorsRerun: boolean;
  recoveredDetectorsCount: number;
}): ReanalysisChangeSummary {
  const { original, updatedScoring, userContext, detectorsRerun, recoveredDetectorsCount } = options;

  const scoreBefore = original.aiLikelihoodScore;
  const scoreAfter = updatedScoring.aiLikelihoodScore;
  const scoreDelta = scoreAfter - scoreBefore;
  const confidenceAdjusted = scoreDelta !== 0 || original.classification !== updatedScoring.classification;

  const whatChanged: string[] = [];

  if (detectorsRerun) {
    if (recoveredDetectorsCount > 0) {
      whatChanged.push(
        `Automated forensic detectors were re-run and recovered ${recoveredDetectorsCount} previously incomplete/failed detector(s), supplying new objective evidence.`,
      );
    } else {
      whatChanged.push(
        'Automated forensic detectors were re-verified on the retained media alongside your submitted context.',
      );
    }
  } else {
    whatChanged.push(
      'Original automated detector measurements were preserved and re-evaluated with your additional context documented separately.',
    );
  }

  if (scoreDelta !== 0) {
    const sign = scoreDelta > 0 ? '+' : '';
    whatChanged.push(
      `Objective AI-likelihood estimate changed from ${scoreBefore}/100 to ${scoreAfter}/100 (${sign}${scoreDelta} pts) based strictly on updated automated detector evidence.`,
    );
  } else {
    whatChanged.push(
      `Objective AI-likelihood estimate remained ${scoreAfter}/100 (unchanged) because no new independently verified technical evidence altered the detector signals.`,
    );
  }

  if (original.classification !== updatedScoring.classification) {
    whatChanged.push(
      `Classification updated from "${original.classification}" to "${updatedScoring.classification}".`,
    );
  }

  if (original.evidenceStrength !== updatedScoring.evidenceStrength) {
    whatChanged.push(
      `Evidence strength updated from ${original.evidenceStrength} to ${updatedScoring.evidenceStrength}.`,
    );
  }

  const answeredCount = userContext.answers.filter((a) => a.answer.trim().length > 0).length;
  whatChanged.push(
    `Recorded ${answeredCount} user follow-up response(s)${userContext.userStatement.trim() ? ' and the user’s written statement' : ''} in a dedicated User-Provided Context section separated from verified forensic evidence.`,
  );

  const adjustmentJustification = confidenceAdjusted
    ? recoveredDetectorsCount > 0
      ? `Confidence score and/or classification were updated strictly because re-running automated detectors recovered ${recoveredDetectorsCount} additional objective detector output(s) — not because of user opinion.`
      : 'Confidence score/classification reflects the latest objectively detected forensic measurements; user-provided statements did not override objective evidence.'
    : 'Confidence score was intentionally kept unchanged because user-provided explanations and opinions are not independently verified forensic evidence. Your context is documented alongside the objective findings to guide human review.';

  return {
    updatedAt: new Date().toISOString(),
    scoreBefore,
    scoreAfter,
    scoreDelta,
    classificationBefore: original.classification,
    classificationAfter: updatedScoring.classification,
    evidenceStrengthBefore: original.evidenceStrength,
    evidenceStrengthAfter: updatedScoring.evidenceStrength,
    confidenceAdjusted,
    adjustmentJustification,
    whatChanged,
    epistemicSeparationNote:
      'User-provided answers and statements are recorded transparently as user-supplied context and are NEVER treated as independently verified forensic evidence. Confidence scores strictly reflect objectively detected signals.',
  };
}
