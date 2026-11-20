import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import 'dotenv/config';
import express, { type Express } from 'express';
import multer from 'multer';
import type { DatasetRecord, SystemCapabilities } from '../src/types/forensics.ts';
import { evaluateBenchmarkDataset } from './evaluationEngine.ts';
import { GEMINI_FORENSIC_MODEL, isGeminiConfigured } from './geminiClient.ts';
import {
  createQueuedAnalysis,
  executeForensicPipeline,
  PipelineRetryError,
  retryAnalysisPipeline,
  submitFollowUpAndReanalyse,
} from './orchestrator.ts';
import {
  deleteAnalysis,
  deleteDatasetRecord,
  ensureStorageReady,
  getAnalysisById,
  getSettings,
  importDatasetRecords,
  IS_SERVERLESS,
  listAnalyses,
  listDatasetRecords,
  parseCsvToDatasetRecords,
  serializeDatasetToCsv,
  updateSettings,
  UPLOADS_DIR,
  upsertDatasetRecord,
  validateDatasetCollection,
} from './storage.ts';

const execFileAsync = promisify(execFile);

export const TEMP_UPLOAD_DIR = path.join(os.tmpdir(), 'truthlens-uploads');

export async function detectSystemCapabilities(): Promise<SystemCapabilities> {
  const checkBin = async (bin: string) => {
    try {
      await execFileAsync(bin, ['-version'], { timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  };
  const [ffmpegAvailable, ffprobeAvailable] = await Promise.all([
    checkBin('ffmpeg'),
    checkBin('ffprobe'),
  ]);
  return {
    ffmpegAvailable,
    ffprobeAvailable,
    sharpAvailable: true,
    geminiConfigured: isGeminiConfigured(),
    synthIdVerifierAvailable: false,
    c2paCryptographicVerifierAvailable: false,
    storageMode: IS_SERVERLESS
      ? 'Serverless temporary storage (/tmp/truthlens-data)'
      : 'Local server filesystem JSON persistence (./data)',
    geminiModel: GEMINI_FORENSIC_MODEL,
  };
}

let initPromise: Promise<void> | null = null;
function ensureRuntimeInitialized(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      await ensureStorageReady();
      await fs.mkdir(TEMP_UPLOAD_DIR, { recursive: true });
    })().catch((err) => {
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

function asyncHandler(
  fn: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<void>,
): express.RequestHandler {
  return (req, res, next) => {
    void fn(req, res, next).catch(next);
  };
}

export function createApiApp(): Express {
  const app = express();

  // Normalize Vercel rewritten URLs regardless of whether Vercel passes /api/index?__vercel_path=...
  // or /?__vercel_path=... or /index?__vercel_path=...
  app.use((req, _res, next) => {
    if (req.url.includes('__vercel_path=')) {
      try {
        const parsed = new URL(req.url, 'http://localhost');
        const forwardedPath = parsed.searchParams.get('__vercel_path');
        if (forwardedPath !== null) {
          parsed.searchParams.delete('__vercel_path');
          const remainingQs = parsed.searchParams.toString();
          const cleaned = forwardedPath.replace(/^\/+/, '').replace(/^api\/+/, '');
          req.url = `/api/${cleaned}${remainingQs ? `?${remainingQs}` : ''}`;
        }
      } catch {
        // Keep original URL if parsing fails
      }
    }
    next();
  });

  app.use(express.json({ limit: '10mb' }));

  // Prevent browser/CDN caching of live API responses and ensure storage directories exist
  app.use('/api', async (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    try {
      await ensureRuntimeInitialized();
      next();
    } catch (err) {
      next(err);
    }
  });

  // Defensive per-request directory creation in multer diskStorage so /tmp purges never cause upload failures
  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdir(TEMP_UPLOAD_DIR, { recursive: true })
        .then(() => cb(null, TEMP_UPLOAD_DIR))
        .catch((err) => cb(err instanceof Error ? err : new Error(String(err)), TEMP_UPLOAD_DIR));
    },
    filename: (_req, _file, cb) => {
      cb(null, `upload_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`);
    },
  });

  const upload = multer({
    storage,
    limits: {
      fileSize: 500 * 1024 * 1024, // Streaming disk cap 500MB; per-setting limit checked in fileValidation
      files: 6,
    },
  });

  // Health & capabilities
  app.get(
    '/api/health',
    asyncHandler(async (_req, res) => {
      const capabilities = await detectSystemCapabilities();
      res.json({ ok: true, status: 'ok', serverless: IS_SERVERLESS, capabilities });
    }),
  );

  // Settings
  app.get(
    '/api/settings',
    asyncHandler(async (_req, res) => {
      const [settings, capabilities] = await Promise.all([getSettings(), detectSystemCapabilities()]);
      res.json({ ok: true, settings, capabilities });
    }),
  );

  app.put(
    '/api/settings',
    asyncHandler(async (req, res) => {
      const updated = await updateSettings(req.body ?? {});
      res.json({ ok: true, settings: updated });
    }),
  );

  // Analyses list + live stats
  app.get(
    '/api/analyses',
    asyncHandler(async (req, res) => {
      const all = await listAnalyses();
      const q = String(req.query.q ?? '').trim().toLowerCase();
      const mediaType = String(req.query.mediaType ?? '').trim();
      const classification = String(req.query.classification ?? '').trim();

      const filtered = all.filter((item) => {
        if (q && !item.fileName.toLowerCase().includes(q) && !item.id.toLowerCase().includes(q)) {
          return false;
        }
        if (mediaType && mediaType !== 'all' && item.mediaType !== mediaType) return false;
        if (
          classification &&
          classification !== 'all' &&
          (item.scoring?.classification ?? '') !== classification
        ) {
          return false;
        }
        return true;
      });

      const completed = all.filter(
        (a) => a.status === 'completed' || a.status === 'partially_completed',
      );
      const partialCount = all.filter((a) => a.status === 'partially_completed').length;
      const elevatedAiCount = completed.filter(
        (a) =>
          a.scoring?.classification === 'Likely AI-generated' ||
          a.scoring?.classification === 'Potentially AI-assisted' ||
          a.scoring?.classification === 'Potentially manipulated',
      ).length;
      const inconclusiveCount = completed.filter(
        (a) => a.scoring?.classification === 'Inconclusive',
      ).length;
      const likelyHumanCount = completed.filter(
        (a) => a.scoring?.classification === 'Likely human-created',
      ).length;

      const mediaDistribution: Record<string, number> = {
        image: 0,
        video: 0,
        pdf: 0,
        document: 0,
        audio: 0,
      };
      for (const a of all) {
        mediaDistribution[a.mediaType] = (mediaDistribution[a.mediaType] ?? 0) + 1;
      }

      res.json({
        ok: true,
        analyses: filtered,
        stats: {
          totalAnalyses: all.length,
          completedCount: completed.length,
          partialCount,
          processingCount: all.filter((a) => a.status === 'processing').length,
          elevatedAiCount,
          inconclusiveCount,
          likelyHumanCount,
          mediaDistribution,
        },
      });
    }),
  );

  // Get single analysis (polled by Analysis Workspace for live stages)
  app.get(
    '/api/analyses/:id',
    asyncHandler(async (req, res) => {
      const record = await getAnalysisById(req.params.id);
      if (!record) {
        res.status(404).json({
          ok: false,
          error: 'Analysis record not found.',
          code: 'ANALYSIS_NOT_FOUND',
        });
        return;
      }
      res.json({ ok: true, analysis: record });
    }),
  );

  // Upload one or multiple files and launch independent forensic pipelines
  app.post('/api/analyses/upload', (req, res) => {
    upload.array('files', 6)(req, res, async (err) => {
      if (err) {
        const message =
          err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE'
            ? 'Uploaded file exceeds the maximum allowed upload size.'
            : err.message || 'Upload failed.';
        res.status(400).json({ ok: false, error: message, code: 'UPLOAD_ERROR' });
        return;
      }

      const files = (req.files as Express.Multer.File[]) ?? [];
      if (files.length === 0) {
        res
          .status(400)
          .json({ ok: false, error: 'Please select at least one file to analyse.', code: 'NO_FILES' });
        return;
      }

      try {
        const created = [];
        const fileErrors: Array<{ fileName: string; error: string }> = [];

        for (const file of files) {
          try {
            const { analysis, storedFilePath } = await createQueuedAnalysis({
              tempFilePath: file.path,
              originalName: file.originalname,
              declaredMime: file.mimetype,
            });
            if (IS_SERVERLESS) {
              // Execute synchronously inside serverless invocation so the container isn't frozen mid-pipeline
              // and subsequent cross-container polls cannot 404.
              await executeForensicPipeline(analysis, storedFilePath);
              const finished = (await getAnalysisById(analysis.id)) ?? analysis;
              created.push(finished);
            } else {
              created.push(analysis);
              // Execute real pipeline asynchronously so Analysis Workspace tracks live server stages
              void executeForensicPipeline(analysis, storedFilePath);
            }
          } catch (fileErr) {
            await fs.rm(file.path, { force: true }).catch(() => undefined);
            fileErrors.push({
              fileName: file.originalname,
              error: fileErr instanceof Error ? fileErr.message : 'Failed to initialize analysis for file.',
            });
          }
        }

        if (created.length === 0) {
          res.status(400).json({
            ok: false,
            error: fileErrors[0]?.error || 'Failed to initialize forensic analysis for uploaded files.',
            code: 'PIPELINE_INIT_ERROR',
            fileErrors,
          });
          return;
        }

        res.status(IS_SERVERLESS ? 200 : 202).json({
          ok: true,
          mode: IS_SERVERLESS ? 'sync' : 'async',
          analyses: created,
          ...(fileErrors.length > 0 ? { fileErrors } : {}),
        });
      } catch (e) {
        res.status(500).json({
          ok: false,
          error: e instanceof Error ? e.message : 'Failed to initialize forensic analysis.',
          code: 'PIPELINE_INIT_ERROR',
        });
      }
    });
  });

  // Built-in sample specimen trigger so reviewers can verify the complete real backend pipeline in one click
  app.post('/api/analyses/sample', async (req, res) => {
    const sampleType = String(req.body?.sampleType ?? 'image');
    try {
      await fs.mkdir(TEMP_UPLOAD_DIR, { recursive: true });
      let tempPath = '';
      let originalName = '';
      let declaredMime = '';

      if (sampleType === 'document') {
        tempPath = path.join(TEMP_UPLOAD_DIR, `sample_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.txt`);
        const sampleDoc = [
          'Executive Briefing: Municipal Water Resilience Infrastructure Plan (2026-2030)',
          '',
          'In today’s rapidly evolving climate landscape, urban municipalities face unprecedented challenges in maintaining reliable potable water distribution systems. It is important to note that comprehensive modernization plays a pivotal role in safeguarding public infrastructure while simultaneously optimizing long-term operational expenditures.',
          '',
          'Furthermore, by leveraging advanced acoustic leak-detection telemetry alongside predictive hydraulic modeling, utility operators can seamlessly identify structural anomalies prior to catastrophic main failures. This holistic approach not only enhances service continuity, but also underscores our unwavering commitment to sustainable resource stewardship.',
          '',
          'Field engineer note (added 14 Nov): Pump station #4 on Mercer Ave still loses ~11 psi every Tuesday morning when the dairy plant shifts washdown cycles—recommend swapping the 1998 check valve before winter freeze hits.',
        ].join('\n');
        await fs.writeFile(tempPath, sampleDoc, 'utf-8');
        originalName = 'municipal_water_briefing_specimen.txt';
        declaredMime = 'text/plain';
      } else {
        const specimenSrc = path.resolve(
          process.cwd(),
          'src/assets/images/forensic_specimen_architecture_1795085183127.jpg',
        );
        tempPath = path.join(TEMP_UPLOAD_DIR, `sample_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.jpg`);
        await fs.copyFile(specimenSrc, tempPath);
        originalName = 'research_pavilion_specimen.jpg';
        declaredMime = 'image/jpeg';
      }

      const { analysis, storedFilePath } = await createQueuedAnalysis({
        tempFilePath: tempPath,
        originalName,
        declaredMime,
      });

      if (IS_SERVERLESS) {
        await executeForensicPipeline(analysis, storedFilePath);
        const finished = (await getAnalysisById(analysis.id)) ?? analysis;
        res.status(200).json({ ok: true, mode: 'sync', analysis: finished });
      } else {
        void executeForensicPipeline(analysis, storedFilePath);
        res.status(202).json({ ok: true, mode: 'async', analysis });
      }
    } catch (e) {
      res.status(500).json({
        ok: false,
        error: e instanceof Error ? e.message : 'Unable to launch sample specimen analysis.',
        code: 'SAMPLE_ERROR',
      });
    }
  });

  // Retry recoverable analysis or Gemini multimodal stage (reuses cached video frames when present)
  app.post(
    '/api/analyses/:id/retry',
    asyncHandler(async (req, res) => {
      try {
        const analysis = await retryAnalysisPipeline(req.params.id, {
          awaitCompletion: IS_SERVERLESS,
        });
        res.status(IS_SERVERLESS ? 200 : 202).json({
          ok: true,
          mode: IS_SERVERLESS ? 'sync' : 'async',
          analysis,
        });
      } catch (e) {
        if (e instanceof PipelineRetryError) {
          res.status(e.statusCode).json({ ok: false, error: e.message, code: e.code });
          return;
        }
        res.status(500).json({
          ok: false,
          error: e instanceof Error ? e.message : 'Unable to retry forensic analysis.',
          code: 'RETRY_ERROR',
        });
      }
    }),
  );

  // Submit interactive follow-up answers & user statement and generate transparent updated report
  app.post(
    '/api/analyses/:id/followup',
    asyncHandler(async (req, res) => {
      try {
        const body = req.body ?? {};
        const analysis = await submitFollowUpAndReanalyse({
          analysisId: req.params.id,
          answers: Array.isArray(body.answers) ? body.answers : [],
          userStatement: typeof body.userStatement === 'string' ? body.userStatement : '',
          rerunAutomatedDetectors: Boolean(body.rerunAutomatedDetectors),
        });
        res.status(200).json({
          ok: true,
          mode: 'sync',
          analysis,
        });
      } catch (e) {
        if (e instanceof PipelineRetryError) {
          res.status(e.statusCode).json({ ok: false, error: e.message, code: e.code });
          return;
        }
        res.status(500).json({
          ok: false,
          error: e instanceof Error ? e.message : 'Unable to reanalyse with follow-up context.',
          code: 'FOLLOWUP_ERROR',
        });
      }
    }),
  );

  // Delete analysis and purge stored media
  app.delete(
    '/api/analyses/:id',
    asyncHandler(async (req, res) => {
      const deleted = await deleteAnalysis(req.params.id);
      if (!deleted) {
        res.status(404).json({ ok: false, error: 'Analysis not found.', code: 'ANALYSIS_NOT_FOUND' });
        return;
      }
      res.json({ ok: true, deleted: true });
    }),
  );

  // Safely serve retained original media (never executed; nosniff headers)
  app.get('/api/analyses/:id/media', async (req, res) => {
    const record = await getAnalysisById(req.params.id);
    if (!record || !record.mediaRetained) {
      res.status(404).json({ error: 'Original media file is no longer retained.' });
      return;
    }
    const dir = path.join(UPLOADS_DIR, record.id);
    try {
      const files = await fs.readdir(dir);
      const orig = files.find((f) => f.startsWith('original.'));
      if (!orig) {
        res.status(404).json({ error: 'Original file missing on disk.' });
        return;
      }
      const fullPath = path.join(dir, orig);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; media-src 'self'; img-src 'self';");
      res.setHeader('Content-Type', record.mimeType || 'application/octet-stream');
      if (req.query.download === '1') {
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${record.fileName.replace(/["\\]/g, '')}"`,
        );
      }
      res.sendFile(fullPath);
    } catch {
      res.status(404).json({ error: 'Media file unavailable.' });
    }
  });

  // Serve extracted video frame JPEG thumbnail
  app.get('/api/analyses/:id/frames/:frameFile', async (req, res) => {
    const safeName = path.basename(req.params.frameFile);
    if (!/^frame_\d+\.jpg$/.test(safeName)) {
      res.status(400).json({ error: 'Invalid frame filename.' });
      return;
    }
    const framePath = path.join(UPLOADS_DIR, path.basename(req.params.id), 'frames', safeName);
    try {
      await fs.access(framePath);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Type', 'image/jpeg');
      res.sendFile(framePath);
    } catch {
      res.status(404).json({ error: 'Frame thumbnail not found.' });
    }
  });

  // Serve saved watermark evidence crop screenshot
  app.get('/api/analyses/:id/watermarks/:cropFile', async (req, res) => {
    const safeName = path.basename(req.params.cropFile);
    if (!/^wm_crop_\d+\.jpg$/.test(safeName)) {
      res.status(400).json({ error: 'Invalid watermark crop filename.' });
      return;
    }
    const cropPath = path.join(UPLOADS_DIR, path.basename(req.params.id), 'watermarks', safeName);
    try {
      await fs.access(cropPath);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Type', 'image/jpeg');
      res.sendFile(cropPath);
    } catch {
      res.status(404).json({ error: 'Watermark crop image not found.' });
    }
  });

  // Export JSON forensic report
  app.get('/api/analyses/:id/export/json', async (req, res) => {
    const record = await getAnalysisById(req.params.id);
    if (!record) {
      res.status(404).json({ error: 'Analysis not found.' });
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="truthlens-report-${record.id}.json"`);
    res.send(JSON.stringify(record, null, 2));
  });

  // Dataset management routes
  app.get('/api/datasets', asyncHandler(async (_req, res) => {
    const records = await listDatasetRecords();
    const validation = validateDatasetCollection(records);
    res.json({ ok: true, records, validation });
  }));

  // Real benchmark evaluation metrics (FPR, FNR, Precision, Recall, F1, Accuracy, ROC-AUC)
  app.get('/api/datasets/evaluate', asyncHandler(async (req, res) => {
    const thresholdRaw = Number(req.query.threshold ?? 60);
    const threshold = Number.isFinite(thresholdRaw) ? thresholdRaw : 60;
    const [records, analyses] = await Promise.all([listDatasetRecords(), listAnalyses()]);
    const evaluation = evaluateBenchmarkDataset(records, analyses, threshold);
    res.json({ ok: true, evaluation });
  }));

  app.post('/api/datasets', asyncHandler(async (req, res) => {
    const body = req.body as Partial<DatasetRecord>;
    if (!body?.sample_id || !body?.file_name) {
      res.status(400).json({ ok: false, error: 'sample_id and file_name are required.' });
      return;
    }
    const record: DatasetRecord = {
      sample_id: String(body.sample_id).trim(),
      file_name: String(body.file_name).trim(),
      media_type: body.media_type || 'image',
      ground_truth_label: body.ground_truth_label || 'UNKNOWN',
      generation_platform: body.generation_platform || '',
      generation_model: body.generation_model || '',
      creation_method: body.creation_method || '',
      visible_watermark: Boolean(body.visible_watermark),
      watermark_text: body.watermark_text || '',
      invisible_watermark_status: body.invisible_watermark_status || 'not_verified',
      c2pa_status: body.c2pa_status || 'absent',
      mime_type: body.mime_type || '',
      file_size_bytes: body.file_size_bytes ?? null,
      width: body.width ?? null,
      height: body.height ?? null,
      duration_seconds: body.duration_seconds ?? null,
      frame_rate: body.frame_rate ?? null,
      codec: body.codec || '',
      creation_timestamp: body.creation_timestamp || '',
      modification_timestamp: body.modification_timestamp || '',
      encoder: body.encoder || '',
      exif_software: body.exif_software || '',
      camera_make: body.camera_make || '',
      camera_model: body.camera_model || '',
      metadata_present: Boolean(body.metadata_present),
      compression_level: body.compression_level || '',
      editing_history: body.editing_history || '',
      manipulation_type: body.manipulation_type || '',
      dataset_source: body.dataset_source || 'Manual Entry',
      license: body.license || '',
      consent_status: body.consent_status || '',
      split: body.split || 'train',
      notes: body.notes || '',
      file_hash: body.file_hash || '',
      recording_condition: body.recording_condition || '',
      predicted_score:
        typeof body.predicted_score === 'number' && Number.isFinite(body.predicted_score)
          ? Math.max(0, Math.min(100, Math.round(body.predicted_score)))
          : null,
      predicted_classification: body.predicted_classification || '',
      linked_analysis_id: body.linked_analysis_id || '',
      is_illustrative_seed: false,
    };
    try {
      const saved = await upsertDatasetRecord(record);
      const records = await listDatasetRecords();
      res.status(201).json({ ok: true, record: saved, validation: validateDatasetCollection(records) });
    } catch (e) {
      res.status(409).json({
        ok: false,
        error: e instanceof Error ? e.message : 'Dataset record conflicts with split governance.',
      });
    }
  }));

  app.delete('/api/datasets/:sampleId', asyncHandler(async (req, res) => {
    const deleted = await deleteDatasetRecord(req.params.sampleId);
    if (!deleted) {
      res.status(404).json({ ok: false, error: 'Dataset record not found.', code: 'DATASET_NOT_FOUND' });
      return;
    }
    const records = await listDatasetRecords();
    res.json({ ok: true, deleted: true, validation: validateDatasetCollection(records) });
  }));

  app.post('/api/datasets/import', asyncHandler(async (req, res) => {
    const csvText = String(req.body?.csv ?? '');
    if (!csvText.trim()) {
      res.status(400).json({ ok: false, error: 'CSV content is empty.' });
      return;
    }
    const parsed = parseCsvToDatasetRecords(csvText);
    if (parsed.length === 0) {
      res.status(400).json({ ok: false, error: 'No valid data rows found in CSV.' });
      return;
    }
    const result = await importDatasetRecords(parsed);
    const records = await listDatasetRecords();
    res.json({ ok: true, ...result, records, validation: validateDatasetCollection(records) });
  }));

  app.get('/api/datasets/export', asyncHandler(async (_req, res) => {
    const records = await listDatasetRecords();
    const csv = serializeDatasetToCsv(records);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="truthlens-dataset-schema.csv"');
    res.send(csv);
  }));

  // Explicit JSON 404 for unmatched /api/* endpoints (never fall through to HTML)
  app.use('/api', (req, res) => {
    res.status(404).json({
      ok: false,
      error: `API endpoint not found (${req.method} ${req.originalUrl}).`,
      code: 'API_ROUTE_NOT_FOUND',
    });
  });

  // JSON error handler for unexpected server errors
  app.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (req.path.startsWith('/api')) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Internal server error.',
        code: 'INTERNAL_SERVER_ERROR',
      });
      return;
    }
    next(err);
  });

  return app;
}
