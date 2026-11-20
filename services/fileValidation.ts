import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';
import type { MediaType } from '../src/types/forensics.ts';

const execFileAsync = promisify(execFile);

export const ALLOWED_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.mp4',
  '.mov',
  '.webm',
  '.pdf',
  '.docx',
  '.txt',
  '.wav',
  '.mp3',
  '.m4a',
]);

export const MAX_IMAGE_PIXELS = 100_000_000; // Decompression bomb guard (100MP)

export interface ValidatedFile {
  originalName: string;
  extension: string;
  declaredMime: string;
  detectedMime: string;
  mediaType: MediaType;
  fileSizeBytes: number;
  sha256: string;
  warnings: string[];
}

export class FileValidationError extends Error {
  code: 'UNSUPPORTED_FORMAT' | 'FILE_TOO_LARGE' | 'CORRUPTED_FILE' | 'SECURITY_BLOCKED';
  statusCode: number;

  constructor(
    message: string,
    code: 'UNSUPPORTED_FORMAT' | 'FILE_TOO_LARGE' | 'CORRUPTED_FILE' | 'SECURITY_BLOCKED',
    statusCode = 400,
  ) {
    super(message);
    this.name = 'FileValidationError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function classifyByMime(mime: string, ext: string): MediaType | null {
  if (['image/jpeg', 'image/png', 'image/webp'].includes(mime)) {
    return 'image';
  }
  if (['video/mp4', 'video/quicktime', 'video/webm'].includes(mime)) {
    return 'video';
  }
  if (
    [
      'audio/wav',
      'audio/x-wav',
      'audio/vnd.wave',
      'audio/mpeg',
      'audio/mp3',
      'audio/mp4',
      'audio/x-m4a',
      'audio/m4a',
      'audio/aac',
    ].includes(mime)
  ) {
    return 'audio';
  }
  if (mime === 'application/pdf') {
    return 'pdf';
  }
  if (
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    (mime === 'application/zip' && ext === '.docx')
  ) {
    return 'document';
  }
  if (mime === 'text/plain' && ext === '.txt') {
    return 'document';
  }
  return null;
}

function looksLikePlainText(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  if (sample.length === 0) return false;
  let suspiciousControlChars = 0;
  for (let i = 0; i < sample.length; i++) {
    const byte = sample[i];
    if (byte === 0) return false;
    if (byte < 9 || (byte > 13 && byte < 32)) {
      suspiciousControlChars++;
    }
  }
  return suspiciousControlChars / sample.length < 0.02;
}

// Stream SHA-256 computation so large video files (up to 500MB) never spike RAM
export function computeFileSha256Streaming(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fsSync.createReadStream(filePath, { highWaterMark: 64 * 1024 });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function readHeadBuffer(filePath: string, maxBytes: number): Promise<Buffer> {
  const handle = await fs.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    const len = Math.min(stat.size, maxBytes);
    const buf = Buffer.alloc(len);
    await handle.read(buf, 0, len, 0);
    return buf;
  } finally {
    await handle.close();
  }
}

export async function validateUploadedFile(
  filePath: string,
  originalName: string,
  declaredMime: string,
  maxSizeMb: number,
): Promise<ValidatedFile> {
  const stat = await fs.stat(filePath);
  const maxBytes = maxSizeMb * 1024 * 1024;

  if (stat.size === 0) {
    throw new FileValidationError(
      'Uploaded file is empty (0 bytes) and cannot be analysed.',
      'CORRUPTED_FILE',
      400,
    );
  }

  if (stat.size > maxBytes) {
    throw new FileValidationError(
      `File exceeds the configured upload limit of ${maxSizeMb} MB.`,
      'FILE_TOO_LARGE',
      413,
    );
  }

  const ext = path.extname(originalName).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new FileValidationError(
      `Unsupported file format "${ext || 'unknown'}". Supported formats: JPG, JPEG, PNG, WEBP, MP4, MOV, WEBM, PDF, DOCX, TXT, WAV, MP3, M4A.`,
      'UNSUPPORTED_FORMAT',
      415,
    );
  }

  // Stream SHA-256 and read only the header bytes for magic signature detection
  const [sha256, headBuffer] = await Promise.all([
    computeFileSha256Streaming(filePath),
    readHeadBuffer(filePath, 65_536),
  ]);

  const detected = await fileTypeFromBuffer(headBuffer);
  const warnings: string[] = [];

  // Block executable binaries masquerading under media extensions
  if (
    detected &&
    [
      'application/x-msdownload',
      'application/x-elf',
      'application/x-mach-binary',
      'application/x-sh',
    ].includes(detected.mime)
  ) {
    throw new FileValidationError(
      'File binary signature matches an executable and was rejected for security.',
      'SECURITY_BLOCKED',
      400,
    );
  }

  let detectedMime = detected?.mime ?? '';

  if (!detectedMime && ext === '.txt') {
    if (!looksLikePlainText(headBuffer)) {
      throw new FileValidationError(
        'File has a .txt extension but contains binary or corrupted non-text bytes.',
        'CORRUPTED_FILE',
        400,
      );
    }
    detectedMime = 'text/plain';
  }

  if (
    ext === '.m4a' &&
    (detectedMime === 'video/mp4' || detectedMime === 'audio/mp4' || detectedMime === 'audio/x-m4a')
  ) {
    detectedMime = 'audio/mp4';
  }

  if (
    ext === '.docx' &&
    (detectedMime === 'application/zip' ||
      detectedMime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  ) {
    const zipHead = headBuffer.toString('latin1');
    if (!zipHead.includes('word/') && !zipHead.includes('[Content_Types].xml')) {
      throw new FileValidationError(
        'File has a .docx extension but does not contain a valid Office Open XML structure.',
        'CORRUPTED_FILE',
        400,
      );
    }
    detectedMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }

  if (ext === '.pdf' || detectedMime === 'application/pdf') {
    const pdfHead = headBuffer.subarray(0, 1024).toString('latin1');
    if (!pdfHead.includes('%PDF-')) {
      throw new FileValidationError(
        'PDF file is missing a valid %PDF header and appears corrupted.',
        'CORRUPTED_FILE',
        400,
      );
    }
    detectedMime = 'application/pdf';
    if (/\/JavaScript\b|\/JS\b|\/Launch\b/i.test(headBuffer.toString('latin1'))) {
      warnings.push(
        'PDF contains active script or launch dictionary entries; inspected statically without execution.',
      );
    }
  }

  if (!detectedMime && ext === '.mp3') {
    if (
      (headBuffer[0] === 0x49 && headBuffer[1] === 0x44 && headBuffer[2] === 0x33) ||
      (headBuffer[0] === 0xff && (headBuffer[1] & 0xe0) === 0xe0)
    ) {
      detectedMime = 'audio/mpeg';
    }
  }

  if (!detectedMime) {
    throw new FileValidationError(
      `Unsupported or corrupted format for "${originalName}" — binary magic signature could not be verified (extension is not trusted).`,
      'CORRUPTED_FILE',
      400,
    );
  }

  const mediaType = classifyByMime(detectedMime, ext);
  if (!mediaType) {
    throw new FileValidationError(
      `Unsupported binary format "${detectedMime}" for "${originalName}" — file extension is not trusted.`,
      'UNSUPPORTED_FORMAT',
      415,
    );
  }

  // Deep decompression-bomb & container-corruption checks by media type
  if (mediaType === 'image') {
    try {
      const meta = await sharp(filePath, { limitInputPixels: MAX_IMAGE_PIXELS }).metadata();
      const pixels = (meta.width ?? 0) * (meta.height ?? 0);
      if (pixels <= 0) {
        throw new FileValidationError(
          'Image header could not be decoded — file appears corrupted.',
          'CORRUPTED_FILE',
          400,
        );
      }
      if (pixels > MAX_IMAGE_PIXELS) {
        throw new FileValidationError(
          `Image resolution (${meta.width}×${meta.height}) exceeds 100MP decompression bomb safety guard.`,
          'SECURITY_BLOCKED',
          400,
        );
      }
      // Verify actual pixel decode integrity
      await sharp(filePath, { limitInputPixels: MAX_IMAGE_PIXELS })
        .resize(16, 16, { fit: 'inside' })
        .raw()
        .toBuffer();
    } catch (err) {
      if (err instanceof FileValidationError) throw err;
      throw new FileValidationError(
        `Image file "${originalName}" failed decode verification and appears corrupted or truncated.`,
        'CORRUPTED_FILE',
        400,
      );
    }
  } else if (mediaType === 'video') {
    try {
      const { stdout } = await execFileAsync(
        'ffprobe',
        ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', filePath],
        { timeout: 15_000 },
      );
      const parsed = JSON.parse(stdout) as {
        streams?: Array<{ codec_type?: string }>;
        format?: { duration?: string };
      };
      const hasVideo = (parsed.streams ?? []).some((s) => s.codec_type === 'video');
      if (!hasVideo) {
        throw new FileValidationError(
          'Video container does not contain a readable video stream or appears corrupted.',
          'CORRUPTED_FILE',
          400,
        );
      }
    } catch (err) {
      if (err instanceof FileValidationError) throw err;
      throw new FileValidationError(
        `Video file "${originalName}" failed FFprobe integrity verification and appears corrupted.`,
        'CORRUPTED_FILE',
        400,
      );
    }
  } else if (mediaType === 'audio') {
    try {
      const { stdout } = await execFileAsync(
        'ffprobe',
        ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'json', filePath],
        { timeout: 12_000 },
      );
      const parsed = JSON.parse(stdout) as { streams?: Array<{ codec_type?: string }> };
      const hasAudio = (parsed.streams ?? []).some((s) => s.codec_type === 'audio');
      if (!hasAudio) {
        throw new FileValidationError(
          'Audio file does not contain a decodable audio stream or appears corrupted.',
          'CORRUPTED_FILE',
          400,
        );
      }
    } catch (err) {
      if (err instanceof FileValidationError) throw err;
      throw new FileValidationError(
        `Audio file "${originalName}" failed FFprobe integrity check and appears corrupted.`,
        'CORRUPTED_FILE',
        400,
      );
    }
  }

  const extExpectedMap: Record<string, MediaType> = {
    '.jpg': 'image',
    '.jpeg': 'image',
    '.png': 'image',
    '.webp': 'image',
    '.mp4': 'video',
    '.mov': 'video',
    '.webm': 'video',
    '.wav': 'audio',
    '.mp3': 'audio',
    '.m4a': 'audio',
    '.pdf': 'pdf',
    '.docx': 'document',
    '.txt': 'document',
  };
  if (extExpectedMap[ext] && extExpectedMap[ext] !== mediaType) {
    warnings.push(
      `Extension "${ext}" disagrees with verified binary signature "${detectedMime}". Routed by verified binary type (${mediaType}).`,
    );
  }

  return {
    originalName,
    extension: ext,
    declaredMime: declaredMime || 'application/octet-stream',
    detectedMime,
    mediaType,
    fileSizeBytes: stat.size,
    sha256,
    warnings,
  };
}
