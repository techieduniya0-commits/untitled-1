import fs from 'node:fs/promises';
import path from 'node:path';
import 'dotenv/config';
import express from 'express';
import { createApiApp, TEMP_UPLOAD_DIR } from './services/app.ts';
import { ensureStorageReady, purgeExpiredMedia } from './services/storage.ts';

const PORT = 3000;

async function startServer() {
  await ensureStorageReady();
  await fs.mkdir(TEMP_UPLOAD_DIR, { recursive: true });
  await purgeExpiredMedia();

  // Periodic retention cleanup every 30 minutes
  setInterval(() => {
    void purgeExpiredMedia();
  }, 30 * 60 * 1000);

  const app = createApiApp();

  // Mount Vite middleware in development (dynamically imported so production/serverless never bundles Vite),
  // or static dist in production
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (req, res) => {
      if (req.path.startsWith('/api')) {
        res.status(404).json({
          ok: false,
          error: 'API endpoint not found.',
          code: 'API_ROUTE_NOT_FOUND',
        });
        return;
      }
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`TruthLens server running at http://0.0.0.0:${PORT}`);
  });
}

void startServer();
