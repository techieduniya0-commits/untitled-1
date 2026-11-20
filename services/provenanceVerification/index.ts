import fs from 'node:fs/promises';
import type { DetectorResult, MediaType, WatermarkFinding } from '../../src/types/forensics.ts';

export interface ProvenanceInspectionOutput {
  c2paStatus: 'present_unverified' | 'absent' | 'unavailable';
  c2paDetails: string;
  iptcDigitalSourceType: string | null;
  c2paDetector: DetectorResult;
  synthIdDetector: DetectorResult;
  provenanceWatermarks: WatermarkFinding[];
}

export async function inspectProvenance(
  filePath: string,
  mediaType: MediaType,
): Promise<ProvenanceInspectionOutput> {
  // Read first 4MB and last 1MB for JUMBF / C2PA / XMP markers without loading giant videos completely into RAM
  const stat = await fs.stat(filePath);
  const handle = await fs.open(filePath, 'r');
  let combinedText = '';

  try {
    const headSize = Math.min(stat.size, 4 * 1024 * 1024);
    const headBuf = Buffer.alloc(headSize);
    await handle.read(headBuf, 0, headSize, 0);
    combinedText += headBuf.toString('latin1');

    if (stat.size > headSize) {
      const tailSize = Math.min(stat.size - headSize, 1024 * 1024);
      const tailBuf = Buffer.alloc(tailSize);
      await handle.read(tailBuf, 0, tailSize, stat.size - tailSize);
      combinedText += '\n' + tailBuf.toString('latin1');
    }
  } finally {
    await handle.close();
  }

  const hasJumbBox = /jumb|c2pa\.claim|c2pa\.assertions|urn:uuid:63327061/i.test(combinedText);
  const hasC2paSignature = /c2pa\.signature|c2pa\.hash\.data|Content Credentials/i.test(combinedText);

  // Extract IPTC digitalSourceType if present in XMP/C2PA XML
  const sourceTypeMatch = combinedText.match(
    /(?:digitalSourceType|trainedAlgorithmicMedia|compositeWithTrainedAlgorithmicMedia|digitalCapture)[^"'<\n]{0,120}/i,
  );
  const iptcDigitalSourceType = sourceTypeMatch ? sourceTypeMatch[0].replace(/[^\x20-\x7E]/g, '').trim() : null;

  const claimsAiGeneration =
    Boolean(iptcDigitalSourceType && /trainedAlgorithmicMedia|algorithmic/i.test(iptcDigitalSourceType)) ||
    /c2pa\.actions.*c2pa\.created.*trainedAlgorithmicMedia/i.test(combinedText);

  let c2paStatus: 'present_unverified' | 'absent' | 'unavailable' = 'absent';
  let c2paDetails = 'No C2PA JUMBF manifest or Content Credentials markers were detected in file headers or trailers.';
  let rawSignalScore: number | null = null;
  let resultSummary = 'No C2PA provenance manifest found.';
  const evidence: string[] = [];

  if (hasJumbBox || hasC2paSignature) {
    c2paStatus = 'present_unverified';
    c2paDetails =
      'C2PA / JUMBF provenance box markers were detected in container bytes. Cryptographic trust-list certificate chain verification requires a dedicated c2patool native verifier, which is not installed in this runtime.';
    evidence.push('Detected C2PA / JUMBF container signature bytes inside file structure.');
    if (iptcDigitalSourceType) {
      evidence.push(`Embedded IPTC/XMP digitalSourceType string observed: "${iptcDigitalSourceType}".`);
    }
    if (claimsAiGeneration) {
      rawSignalScore = 88;
      resultSummary = 'C2PA / XMP provenance markers reference algorithmic / AI creation (unverified certificate chain).';
      evidence.push('Manifest assertions include trainedAlgorithmicMedia / algorithmic generation tag.');
    } else {
      rawSignalScore = 25;
      resultSummary = 'C2PA / JUMBF provenance markers detected (cryptographic chain unverified).';
    }
  } else if (iptcDigitalSourceType) {
    evidence.push(`Found XMP digitalSourceType marker without full C2PA JUMBF manifest: "${iptcDigitalSourceType}".`);
    if (claimsAiGeneration) {
      rawSignalScore = 78;
      resultSummary = 'XMP metadata declares algorithmic media generation.';
    } else {
      rawSignalScore = 30;
      resultSummary = 'XMP digitalSourceType marker present (not cryptographically signed).';
    }
  } else {
    evidence.push('Scanned header and trailer binary segments for JUMBF (jumb) and c2pa.claim markers: none found.');
    evidence.push('Absence of C2PA credentials is common across authentic consumer cameras, social media re-uploads, and unauthenticated AI outputs.');
  }

  const c2paDetector: DetectorResult = {
    id: 'c2pa_provenance',
    methodName: 'C2PA Provenance Inspection',
    category: 'provenance',
    status: 'completed',
    ran: true,
    resultSummary,
    rawSignalScore,
    reliability: hasJumbBox && claimsAiGeneration ? 'High' : 'Moderate',
    calibrationStatus: 'Deterministic Check',
    applicability: `Container signature scan for ${mediaType} files`,
    evidenceStrength: hasJumbBox ? 'Moderate' : 'Low',
    evidence,
    limitations: [
      'Full X.509 cryptographic signature validation against the C2PA Trust List requires c2patool/c2pa-rs, which is not installed in this environment.',
      'Social media platforms, messaging apps, and re-encoding routinely strip valid C2PA manifests from both real and AI media.',
      'Absence of C2PA metadata never proves a file is AI-generated.',
    ],
    toolUsed: 'TruthLens Binary JUMBF / XMP Manifest Scanner',
    correlationGroup: 'provenance_manifest',
  };

  const synthIdDetector: DetectorResult = {
    id: 'synthid_verification',
    methodName: 'SynthID Invisible Watermark Verification',
    category: 'watermark',
    status: 'unavailable',
    ran: false,
    resultSummary: 'Not performed — no supported SynthID cryptographic detector is integrated in this runtime.',
    rawSignalScore: null,
    reliability: 'High',
    calibrationStatus: 'Deterministic Check',
    applicability: mediaType === 'image' || mediaType === 'video' || mediaType === 'audio' ? `Applicable to ${mediaType}` : 'Not applicable',
    evidenceStrength: 'Low',
    evidence: [
      'SynthID imperceptible watermark verification requires access to Google DeepMind’s dedicated SynthID verification SDK/API, which is not available in this server runtime.',
    ],
    limitations: [
      'TruthLens never simulates or guesses invisible watermark presence.',
      'Visible watermark detection is performed separately via OCR and visual logo inspection.',
    ],
    toolUsed: 'Not integrated (Unavailable)',
    correlationGroup: 'invisible_watermark',
  };

  const provenanceWatermarks: WatermarkFinding[] = [
    {
      id: 'wm_invisible_synthid',
      type: 'invisible_watermark',
      detected: false,
      recognizedTextOrLogo: null,
      timestamp: null,
      positionInFrame: null,
      detectionMethod: 'SynthID / Imperceptible Watermark Verification',
      recognitionConfidence: 'Not applicable',
      possiblePlatform: null,
      note: 'Not performed: no supported invisible watermark verification algorithm (such as SynthID) is integrated in this runtime environment.',
    },
    {
      id: 'wm_provenance_c2pa',
      type: 'provenance_marker',
      detected: hasJumbBox || hasC2paSignature || Boolean(iptcDigitalSourceType),
      recognizedTextOrLogo: hasJumbBox
        ? 'C2PA / JUMBF Manifest Marker'
        : iptcDigitalSourceType
          ? `XMP digitalSourceType (${iptcDigitalSourceType})`
          : null,
      timestamp: null,
      positionInFrame: 'File container metadata',
      detectionMethod: 'Binary JUMBF / C2PA / XMP Signature Inspection',
      recognitionConfidence: hasJumbBox ? 'Moderate' : 'Low',
      possiblePlatform: claimsAiGeneration ? 'Declared algorithmic generator (unverified signature)' : null,
      note: c2paDetails,
    },
  ];

  return {
    c2paStatus,
    c2paDetails,
    iptcDigitalSourceType,
    c2paDetector,
    synthIdDetector,
    provenanceWatermarks,
  };
}
