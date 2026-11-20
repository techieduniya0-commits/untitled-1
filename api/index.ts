import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApiApp } from '../services/app.ts';

// Disable automatic body parsing so multer can stream multipart/form-data file uploads directly
export const config = {
  api: {
    bodyParser: false,
  },
};

const app = createApiApp();

export default function handler(req: IncomingMessage, res: ServerResponse) {
  return app(req as Parameters<typeof app>[0], res as Parameters<typeof app>[1]);
}
