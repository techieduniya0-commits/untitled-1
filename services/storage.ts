import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  AnalysisRecord,
  AppSettings,
  DatasetRecord,
  DatasetSplit,
  DatasetValidationSummary,
  GroundTruthLabel,
} from '../src/types/forensics.ts';

export const IS_SERVERLESS = Boolean(
  process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY,
);
export const DATA_DIR = IS_SERVERLESS
  ? path.join(os.tmpdir(), 'truthlens-data')
  : path.resolve(process.cwd(), 'data');
export const UPLOADS_DIR = IS_SERVERLESS
  ? path.join(os.tmpdir(), 'truthlens-uploads-store')
  : path.resolve(process.cwd(), 'uploads');
const ANALYSES_FILE = path.join(DATA_DIR, 'analyses.json');
const DATASETS_FILE = path.join(DATA_DIR, 'datasets.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

export const DATASET_CSV_COLUMNS: Array<keyof DatasetRecord> = [
  'sample_id',
  'file_name',
  'media_type',
  'ground_truth_label',
  'generation_platform',
  'generation_model',
  'creation_method',
  'visible_watermark',
  'watermark_text',
  'invisible_watermark_status',
  'c2pa_status',
  'mime_type',
  'file_size_bytes',
  'width',
  'height',
  'duration_seconds',
  'frame_rate',
  'codec',
  'creation_timestamp',
  'modification_timestamp',
  'encoder',
  'exif_software',
  'camera_make',
  'camera_model',
  'metadata_present',
  'compression_level',
  'editing_history',
  'manipulation_type',
  'dataset_source',
  'license',
  'consent_status',
  'split',
  'notes',
];

const DEFAULT_SETTINGS: AppSettings = {
  retainOriginalMediaHours: 24,
  videoFrameSampleCount: 6,
  maxUploadSizeMb: 50,
  storageBackend: IS_SERVERLESS
    ? 'Serverless temporary storage (/tmp/truthlens-data)'
    : 'Local server filesystem JSON persistence (./data)',
  storageNotice: IS_SERVERLESS
    ? 'Running in serverless mode: analysis records and media are processed inside ephemeral /tmp storage and returned directly to your active session.'
    : 'Analysis reports and dataset schemas persist to local server disk storage in this container. Uploaded media files are stored temporarily and automatically purged after the configured retention window or immediately upon deletion.',
};

const ILLUSTRATIVE_SEED_DATASETS: DatasetRecord[] = [
  {
    sample_id: 'TL-IMG-001',
    file_name: 'illustrative_ai_image_001.png',
    media_type: 'image',
    ground_truth_label: 'AI_GENERATED',
    generation_platform: 'Example AI image generator',
    generation_model: 'Example Diffusion Model',
    creation_method: 'Text-to-image synthesis',
    visible_watermark: true,
    watermark_text: 'Example Generator',
    invisible_watermark_status: 'not_verified',
    c2pa_status: 'absent',
    mime_type: 'image/png',
    file_size_bytes: 1843200,
    width: 1024,
    height: 1024,
    duration_seconds: null,
    frame_rate: null,
    codec: '',
    creation_timestamp: '2026-01-15T09:00:00Z',
    modification_timestamp: '2026-01-15T09:00:00Z',
    encoder: '',
    exif_software: 'Example Generator UI',
    camera_make: '',
    camera_model: '',
    metadata_present: true,
    compression_level: 'Lossless PNG',
    editing_history: 'None',
    manipulation_type: 'None',
    dataset_source: 'TruthLens Illustrative Schema Seed',
    license: 'Internal Schema Example',
    consent_status: 'Synthetic illustrative record',
    split: 'train',
    notes: 'Illustrative seed record for schema verification only — NOT a real verified benchmark sample.',
    file_hash: 'illustrative-seed-hash-cv-img-001',
    is_illustrative_seed: true,
  },
  {
    sample_id: 'TL-VID-001',
    file_name: 'illustrative_ai_video_001.mp4',
    media_type: 'video',
    ground_truth_label: 'AI_GENERATED',
    generation_platform: 'Example AI video generator',
    generation_model: 'Example Video Diffusion',
    creation_method: 'Text-to-video synthesis',
    visible_watermark: true,
    watermark_text: 'Example Video Tool',
    invisible_watermark_status: 'not_verified',
    c2pa_status: 'absent',
    mime_type: 'video/mp4',
    file_size_bytes: 6420000,
    width: 1920,
    height: 1080,
    duration_seconds: 8,
    frame_rate: 30,
    codec: 'H.264',
    creation_timestamp: '2026-01-18T14:20:00Z',
    modification_timestamp: '2026-01-18T14:20:00Z',
    encoder: 'Lavf60.16.100',
    exif_software: '',
    camera_make: '',
    camera_model: '',
    metadata_present: true,
    compression_level: 'Medium H.264',
    editing_history: 'None',
    manipulation_type: 'None',
    dataset_source: 'TruthLens Illustrative Schema Seed',
    license: 'Internal Schema Example',
    consent_status: 'Synthetic illustrative record',
    split: 'train',
    notes: 'Illustrative seed record for schema verification only — NOT a real verified benchmark sample.',
    file_hash: 'illustrative-seed-hash-cv-vid-001',
    is_illustrative_seed: true,
  },
  {
    sample_id: 'TL-IMG-002',
    file_name: 'illustrative_camera_photo_002.jpg',
    media_type: 'image',
    ground_truth_label: 'REAL',
    generation_platform: 'None',
    generation_model: 'None',
    creation_method: 'Direct optical camera capture',
    visible_watermark: false,
    watermark_text: '',
    invisible_watermark_status: 'not_applicable',
    c2pa_status: 'absent',
    mime_type: 'image/jpeg',
    file_size_bytes: 4120500,
    width: 4032,
    height: 3024,
    duration_seconds: null,
    frame_rate: null,
    codec: '',
    creation_timestamp: '2026-02-04T11:30:00Z',
    modification_timestamp: '2026-02-04T11:30:00Z',
    encoder: '',
    exif_software: 'Camera Firmware 2.1',
    camera_make: 'Example Camera',
    camera_model: 'Example Model',
    metadata_present: true,
    compression_level: 'JPEG Q92',
    editing_history: 'Unedited original',
    manipulation_type: 'None',
    dataset_source: 'TruthLens Illustrative Schema Seed',
    license: 'Internal Schema Example',
    consent_status: 'Illustrative placeholder record',
    split: 'validation',
    notes: 'Illustrative seed record for schema verification only — NOT a real verified benchmark sample.',
    file_hash: 'illustrative-seed-hash-cv-img-002',
    is_illustrative_seed: true,
  },
  {
    sample_id: 'TL-VID-002',
    file_name: 'illustrative_manipulated_video_002.mp4',
    media_type: 'video',
    ground_truth_label: 'MANIPULATED',
    generation_platform: 'Unknown',
    generation_model: 'Unknown',
    creation_method: 'Post-capture composite edit',
    visible_watermark: false,
    watermark_text: '',
    invisible_watermark_status: 'not_verified',
    c2pa_status: 'absent',
    mime_type: 'video/mp4',
    file_size_bytes: 9850000,
    width: 1920,
    height: 1080,
    duration_seconds: 12,
    frame_rate: 30,
    codec: 'H.264',
    creation_timestamp: '',
    modification_timestamp: '',
    encoder: '',
    exif_software: '',
    camera_make: '',
    camera_model: '',
    metadata_present: false,
    compression_level: 'Re-encoded web video',
    editing_history: 'Stripped metadata after compositing',
    manipulation_type: 'Visual splice / face or region overlay',
    dataset_source: 'TruthLens Illustrative Schema Seed',
    license: 'Internal Schema Example',
    consent_status: 'Illustrative placeholder record',
    split: 'test',
    notes: 'Illustrative seed record for schema verification only — NOT a real verified benchmark sample.',
    file_hash: 'illustrative-seed-hash-cv-vid-002',
    is_illustrative_seed: true,
  },
];

let writeLock: Promise<void> = Promise.resolve();
let analysesCache: AnalysisRecord[] | null = null;
const deletedAnalysisIds = new Set<string>();

function serializedWrite<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeLock.then(fn, fn);
  writeLock = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

export async function ensureStorageReady(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(UPLOADS_DIR, { recursive: true });

  try {
    await fs.access(ANALYSES_FILE);
  } catch {
    await fs.writeFile(ANALYSES_FILE, '[]', 'utf-8');
  }

  try {
    await fs.access(DATASETS_FILE);
  } catch {
    await fs.writeFile(DATASETS_FILE, JSON.stringify(ILLUSTRATIVE_SEED_DATASETS, null, 2), 'utf-8');
  }

  try {
    await fs.access(SETTINGS_FILE);
  } catch {
    await fs.writeFile(SETTINGS_FILE, JSON.stringify(DEFAULT_SETTINGS, null, 2), 'utf-8');
  }
}

async function readJsonSafe<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  await fs.rename(tmpPath, filePath);
}

// Analyses CRUD
export async function listAnalyses(): Promise<AnalysisRecord[]> {
  await ensureStorageReady();
  const diskList = await readJsonSafe<AnalysisRecord[] | null>(ANALYSES_FILE, null);
  let resolved: AnalysisRecord[];
  if (Array.isArray(diskList)) {
    // Merge with in-memory cache in case a write is actively flushing
    if (analysesCache && analysesCache.length > 0 && diskList.length === 0) {
      resolved = [...analysesCache];
    } else {
      const byId = new Map<string, AnalysisRecord>();
      for (const item of diskList) {
        if (!deletedAnalysisIds.has(item.id)) byId.set(item.id, item);
      }
      analysesCache = Array.from(byId.values());
      resolved = [...analysesCache];
    }
  } else {
    resolved = analysesCache ? [...analysesCache] : [];
  }
  return resolved.sort((a, b) => new Date(b.uploadDate).getTime() - new Date(a.uploadDate).getTime());
}

export async function getAnalysisById(id: string): Promise<AnalysisRecord | null> {
  if (deletedAnalysisIds.has(id)) return null;
  if (analysesCache) {
    const cached = analysesCache.find((item) => item.id === id);
    if (cached) return structuredClone(cached);
  }
  const list = await listAnalyses();
  const found = list.find((item) => item.id === id) ?? null;
  return found ? structuredClone(found) : null;
}

export async function upsertAnalysis(record: AnalysisRecord): Promise<AnalysisRecord> {
  const snapshot = structuredClone(record);
  return serializedWrite(async () => {
    if (deletedAnalysisIds.has(snapshot.id)) {
      return snapshot;
    }
    await ensureStorageReady();
    const diskList = await readJsonSafe<AnalysisRecord[] | null>(ANALYSES_FILE, null);
    const list = Array.isArray(diskList)
      ? diskList.filter((item) => !deletedAnalysisIds.has(item.id))
      : analysesCache
        ? [...analysesCache]
        : [];
    const idx = list.findIndex((item) => item.id === snapshot.id);
    if (idx >= 0) {
      list[idx] = snapshot;
    } else {
      list.unshift(snapshot);
    }
    analysesCache = list.map((item) => structuredClone(item));
    await atomicWriteJson(ANALYSES_FILE, list);
    return snapshot;
  });
}

export async function deleteAnalysis(id: string): Promise<boolean> {
  return serializedWrite(async () => {
    await ensureStorageReady();
    const diskList = await readJsonSafe<AnalysisRecord[] | null>(ANALYSES_FILE, null);
    const list = Array.isArray(diskList) ? diskList : analysesCache ? [...analysesCache] : [];
    const next = list.filter((item) => item.id !== id);
    deletedAnalysisIds.add(id);
    analysesCache = [...next];
    if (next.length !== list.length) {
      await atomicWriteJson(ANALYSES_FILE, next);
    }

    // Purge stored media and extracted frames immediately
    const analysisUploadDir = path.join(UPLOADS_DIR, id);
    await fs.rm(analysisUploadDir, { recursive: true, force: true }).catch(() => undefined);
    return next.length !== list.length;
  });
}

export async function purgeExpiredMedia(): Promise<number> {
  const list = await listAnalyses();
  const now = Date.now();
  let purgedCount = 0;

  for (const item of list) {
    if (item.mediaRetained && item.mediaExpiresAt && new Date(item.mediaExpiresAt).getTime() < now) {
      const dir = path.join(UPLOADS_DIR, item.id);
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      item.mediaRetained = false;
      item.previewUrl = undefined;
      await upsertAnalysis(item);
      purgedCount++;
    }
  }
  return purgedCount;
}

// Settings
export async function getSettings(): Promise<AppSettings> {
  await ensureStorageReady();
  const stored = await readJsonSafe<Partial<AppSettings>>(SETTINGS_FILE, {});
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  return serializedWrite(async () => {
    await ensureStorageReady();
    const current = await getSettings();
    const next: AppSettings = {
      ...current,
      retainOriginalMediaHours:
        typeof patch.retainOriginalMediaHours === 'number'
          ? Math.max(1, Math.min(168, Math.round(patch.retainOriginalMediaHours)))
          : current.retainOriginalMediaHours,
      videoFrameSampleCount:
        typeof patch.videoFrameSampleCount === 'number'
          ? Math.max(4, Math.min(10, Math.round(patch.videoFrameSampleCount)))
          : current.videoFrameSampleCount,
      maxUploadSizeMb:
        typeof patch.maxUploadSizeMb === 'number'
          ? Math.max(5, Math.min(500, Math.round(patch.maxUploadSizeMb)))
          : current.maxUploadSizeMb,
    };
    await atomicWriteJson(SETTINGS_FILE, next);
    return next;
  });
}

// Datasets CRUD, Validation & CSV Import/Export
export async function listDatasetRecords(): Promise<DatasetRecord[]> {
  await ensureStorageReady();
  return readJsonSafe<DatasetRecord[]>(DATASETS_FILE, ILLUSTRATIVE_SEED_DATASETS);
}

export async function upsertDatasetRecord(record: DatasetRecord): Promise<DatasetRecord> {
  return serializedWrite(async () => {
    await ensureStorageReady();
    const list = await readJsonSafe<DatasetRecord[]>(DATASETS_FILE, ILLUSTRATIVE_SEED_DATASETS);

    // Block cross-split hash leakage between train / validation / test
    if (record.file_hash && record.split !== 'live_upload') {
      const collision = list.find(
        (existing) =>
          existing.sample_id !== record.sample_id &&
          existing.file_hash === record.file_hash &&
          existing.split !== 'live_upload' &&
          existing.split !== record.split,
      );
      if (collision) {
        throw new Error(
          `Cross-split leakage blocked: SHA hash matches existing sample "${collision.sample_id}" in "${collision.split}" split.`,
        );
      }
    }

    const idx = list.findIndex((r) => r.sample_id === record.sample_id);
    if (idx >= 0) {
      list[idx] = record;
    } else {
      list.unshift(record);
    }
    await atomicWriteJson(DATASETS_FILE, list);
    return record;
  });
}

export async function deleteDatasetRecord(sampleId: string): Promise<boolean> {
  return serializedWrite(async () => {
    await ensureStorageReady();
    const list = await readJsonSafe<DatasetRecord[]>(DATASETS_FILE, ILLUSTRATIVE_SEED_DATASETS);
    const next = list.filter((r) => r.sample_id !== sampleId);
    if (next.length === list.length) return false;
    await atomicWriteJson(DATASETS_FILE, next);
    return true;
  });
}

export async function importDatasetRecords(records: DatasetRecord[]): Promise<{
  importedCount: number;
  skippedDuplicateIds: string[];
  blockedLeakageIds: string[];
}> {
  return serializedWrite(async () => {
    await ensureStorageReady();
    const existing = await readJsonSafe<DatasetRecord[]>(DATASETS_FILE, ILLUSTRATIVE_SEED_DATASETS);
    const existingIds = new Set(existing.map((r) => r.sample_id));
    const hashToEvalSplit = new Map<string, string>();
    for (const e of existing) {
      if (e.file_hash && e.split !== 'live_upload') {
        hashToEvalSplit.set(e.file_hash, e.split);
      }
    }

    const skippedDuplicateIds: string[] = [];
    const blockedLeakageIds: string[] = [];
    let importedCount = 0;

    for (const rec of records) {
      if (!rec.sample_id) continue;
      if (existingIds.has(rec.sample_id)) {
        skippedDuplicateIds.push(rec.sample_id);
        continue;
      }
      if (rec.file_hash && rec.split !== 'live_upload') {
        const priorSplit = hashToEvalSplit.get(rec.file_hash);
        if (priorSplit && priorSplit !== rec.split) {
          blockedLeakageIds.push(rec.sample_id);
          continue;
        }
        hashToEvalSplit.set(rec.file_hash, rec.split);
      }
      existingIds.add(rec.sample_id);
      existing.unshift({ ...rec, is_illustrative_seed: false });
      importedCount++;
    }

    await atomicWriteJson(DATASETS_FILE, existing);
    return { importedCount, skippedDuplicateIds, blockedLeakageIds };
  });
}

export function validateDatasetCollection(records: DatasetRecord[]): DatasetValidationSummary {
  const splitCounts: Record<DatasetSplit, number> = {
    train: 0,
    validation: 0,
    test: 0,
    live_upload: 0,
  };
  const labelCounts: Record<GroundTruthLabel, number> = {
    REAL: 0,
    AI_GENERATED: 0,
    AI_ASSISTED: 0,
    MANIPULATED: 0,
    UNKNOWN: 0,
  };
  const mediaTypeCounts: Record<string, number> = {};

  const seenIds = new Map<string, number>();
  const hashSplits = new Map<string, Set<string>>();
  const sourceStemSplits = new Map<string, Set<string>>();
  const duplicateSampleIds: string[] = [];
  const duplicateHashes: string[] = [];
  const crossSplitLeakageWarnings: string[] = [];
  const invalidRows: Array<{ sample_id: string; issues: string[] }> = [];

  let illustrativeSeedCount = 0;
  let missingMetadataCount = 0;
  let missingConsentOrLicenseCount = 0;

  const validLabels = new Set<GroundTruthLabel>([
    'REAL',
    'AI_GENERATED',
    'AI_ASSISTED',
    'MANIPULATED',
    'UNKNOWN',
  ]);
  const validSplits = new Set<DatasetSplit>(['train', 'validation', 'test', 'live_upload']);

  for (const r of records) {
    if (r.is_illustrative_seed) illustrativeSeedCount++;
    if (validSplits.has(r.split)) splitCounts[r.split]++;
    if (validLabels.has(r.ground_truth_label)) labelCounts[r.ground_truth_label]++;
    mediaTypeCounts[r.media_type] = (mediaTypeCounts[r.media_type] ?? 0) + 1;

    if (!r.metadata_present) missingMetadataCount++;
    if (!r.license?.trim() || !r.consent_status?.trim()) missingConsentOrLicenseCount++;

    const idCount = (seenIds.get(r.sample_id) ?? 0) + 1;
    seenIds.set(r.sample_id, idCount);
    if (idCount === 2) duplicateSampleIds.push(r.sample_id);

    if (r.file_hash) {
      const splits = hashSplits.get(r.file_hash) ?? new Set<string>();
      if (splits.size > 0 && !duplicateHashes.includes(r.file_hash)) {
        duplicateHashes.push(r.file_hash);
      }
      splits.add(r.split);
      hashSplits.set(r.file_hash, splits);
    }

    // Detect potential near-duplicate source leakage across train/val/test by normalized filename stem
    const normalizedStem = r.file_name
      .toLowerCase()
      .replace(/\.[^.]+$/, '')
      .replace(/(_compressed|_resized|_reencoded|_v\d+|_copy)$/i, '');
    if (normalizedStem.length > 3 && r.split !== 'live_upload') {
      const s = sourceStemSplits.get(normalizedStem) ?? new Set<string>();
      s.add(r.split);
      sourceStemSplits.set(normalizedStem, s);
    }

    const issues: string[] = [];
    if (!r.sample_id?.trim()) issues.push('Missing sample_id');
    if (!r.file_name?.trim()) issues.push('Missing file_name');
    if (!validLabels.has(r.ground_truth_label)) issues.push(`Invalid ground_truth_label "${r.ground_truth_label}"`);
    if (!validSplits.has(r.split)) issues.push(`Invalid split "${r.split}"`);
    if (issues.length > 0) invalidRows.push({ sample_id: r.sample_id || '(blank)', issues });
  }

  for (const [hash, splits] of hashSplits.entries()) {
    const evalSplits = Array.from(splits).filter((s) => s !== 'live_upload');
    if (evalSplits.length > 1) {
      crossSplitLeakageWarnings.push(
        `Exact hash collision across splits (${evalSplits.join(' & ')}): ${hash.slice(0, 16)}…`,
      );
    }
  }

  for (const [stem, splits] of sourceStemSplits.entries()) {
    if (splits.size > 1) {
      crossSplitLeakageWarnings.push(
        `Potential source version leakage across splits (${Array.from(splits).join(' & ')}) for stem "${stem}".`,
      );
    }
  }

  return {
    totalRecords: records.length,
    illustrativeSeedCount,
    splitCounts,
    labelCounts,
    mediaTypeCounts,
    duplicateSampleIds,
    duplicateHashes,
    crossSplitLeakageWarnings,
    missingMetadataCount,
    missingConsentOrLicenseCount,
    invalidRows,
  };
}

function escapeCsvCell(val: unknown): string {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function serializeDatasetToCsv(records: DatasetRecord[]): string {
  const header = DATASET_CSV_COLUMNS.join(',');
  const rows = records.map((rec) =>
    DATASET_CSV_COLUMNS.map((col) => escapeCsvCell(rec[col])).join(','),
  );
  return [header, ...rows].join('\n');
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      cells.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells;
}

export function parseCsvToDatasetRecords(csvText: string): DatasetRecord[] {
  const lines = csvText
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]).map((h) => h.trim());
  const out: DatasetRecord[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h] = (values[idx] ?? '').trim();
    });

    const parseNum = (v?: string): number | null => {
      if (!v) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const parseBool = (v?: string): boolean => v?.toLowerCase() === 'true' || v === '1';

    const label = (['REAL', 'AI_GENERATED', 'AI_ASSISTED', 'MANIPULATED', 'UNKNOWN'].includes(
      row.ground_truth_label,
    )
      ? row.ground_truth_label
      : 'UNKNOWN') as GroundTruthLabel;

    const split = (['train', 'validation', 'test', 'live_upload'].includes(row.split)
      ? row.split
      : 'train') as DatasetSplit;

    out.push({
      sample_id: row.sample_id || `TL-IMP-${Date.now()}-${i}`,
      file_name: row.file_name || 'unnamed_sample',
      media_type: row.media_type || 'image',
      ground_truth_label: label,
      generation_platform: row.generation_platform || '',
      generation_model: row.generation_model || '',
      creation_method: row.creation_method || '',
      visible_watermark: parseBool(row.visible_watermark),
      watermark_text: row.watermark_text || '',
      invisible_watermark_status: row.invisible_watermark_status || 'not_verified',
      c2pa_status: row.c2pa_status || 'absent',
      mime_type: row.mime_type || '',
      file_size_bytes: parseNum(row.file_size_bytes),
      width: parseNum(row.width),
      height: parseNum(row.height),
      duration_seconds: parseNum(row.duration_seconds),
      frame_rate: parseNum(row.frame_rate),
      codec: row.codec || '',
      creation_timestamp: row.creation_timestamp || '',
      modification_timestamp: row.modification_timestamp || '',
      encoder: row.encoder || '',
      exif_software: row.exif_software || '',
      camera_make: row.camera_make || '',
      camera_model: row.camera_model || '',
      metadata_present: parseBool(row.metadata_present),
      compression_level: row.compression_level || '',
      editing_history: row.editing_history || '',
      manipulation_type: row.manipulation_type || '',
      dataset_source: row.dataset_source || 'CSV Import',
      license: row.license || '',
      consent_status: row.consent_status || '',
      split,
      notes: row.notes || '',
      file_hash: row.file_hash || '',
      recording_condition: row.recording_condition || '',
      predicted_score: parseNum(row.predicted_score),
      predicted_classification: (row.predicted_classification || '') as DatasetRecord['predicted_classification'],
      linked_analysis_id: row.linked_analysis_id || '',
      is_illustrative_seed: false,
    });
  }

  return out;
}
