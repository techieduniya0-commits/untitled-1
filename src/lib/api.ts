import type { AnalysisRecord } from '../types/forensics';

export interface ApiErrorInfo {
  status: number;
  code: string;
  endpoint: string;
  message: string;
  details: string;
  retryable: boolean;
  suggestRefresh?: boolean;
}

export class ApiRequestError extends Error implements ApiErrorInfo {
  status: number;
  code: string;
  endpoint: string;
  details: string;
  retryable: boolean;
  suggestRefresh?: boolean;

  constructor(info: ApiErrorInfo) {
    super(info.message);
    this.name = 'ApiRequestError';
    this.status = info.status;
    this.code = info.code;
    this.endpoint = info.endpoint;
    this.details = info.details;
    this.retryable = info.retryable;
    this.suggestRefresh = info.suggestRefresh;
  }
}

const inflightGetRequests = new Map<string, Promise<unknown>>();

function parseJsonBody(
  rawText: string,
  contentType: string,
  status: number,
  endpoint: string,
): { ok: true; data: Record<string, unknown> } | { ok: false; error: ApiRequestError } {
  const trimmed = rawText.trim();
  const looksLikeHtml =
    contentType.includes('text/html') ||
    trimmed.startsWith('<!doctype') ||
    trimmed.startsWith('<!DOCTYPE') ||
    trimmed.startsWith('<html');

  if (looksLikeHtml) {
    return {
      ok: false,
      error: new ApiRequestError({
        status,
        code: 'NON_JSON_RESPONSE',
        endpoint,
        message:
          status === 200
            ? 'Received an HTML page instead of API data. The backend route may be temporarily restarting or misrouted.'
            : `Endpoint ${endpoint} returned an HTML error page (HTTP ${status}).`,
        details: `HTTP ${status} · Content-Type: ${contentType || 'unknown'} · Endpoint: ${endpoint}`,
        retryable: true,
        suggestRefresh: true,
      }),
    };
  }

  if (!trimmed) {
    return {
      ok: false,
      error: new ApiRequestError({
        status,
        code: 'EMPTY_RESPONSE',
        endpoint,
        message: `Server returned an empty response (HTTP ${status}).`,
        details: `HTTP ${status} · Empty body · Endpoint: ${endpoint}`,
        retryable: true,
      }),
    };
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    return { ok: true, data: parsed };
  } catch {
    return {
      ok: false,
      error: new ApiRequestError({
        status,
        code: 'INVALID_JSON',
        endpoint,
        message:
          status === 413
            ? 'Uploaded file exceeds the hosting request size limit. Try a smaller file or split your batch.'
            : status === 404
              ? `API endpoint ${endpoint} was not found (HTTP 404).`
              : `Server returned malformed data (HTTP ${status}).`,
        details: `HTTP ${status} · Content-Type: ${contentType || 'unknown'} · Snippet: ${trimmed.slice(0, 120)}`,
        retryable: status === 0 || status >= 500 || status === 200,
        suggestRefresh: status === 200 || status === 404,
      }),
    };
  }
}

export async function apiRequest<T>(
  endpoint: string,
  options?: {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    body?: unknown;
    timeoutMs?: number;
    signal?: AbortSignal;
    dedupeGet?: boolean;
  },
): Promise<{ status: number; data: T }> {
  const method = options?.method ?? 'GET';
  const timeoutMs = options?.timeoutMs ?? 25_000;
  const dedupeKey = method === 'GET' && options?.dedupeGet !== false ? endpoint : null;

  if (dedupeKey && inflightGetRequests.has(dedupeKey)) {
    return inflightGetRequests.get(dedupeKey) as Promise<{ status: number; data: T }>;
  }

  const run = async (): Promise<{ status: number; data: T }> => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);

    const onExternalAbort = () => controller.abort();
    options?.signal?.addEventListener('abort', onExternalAbort, { once: true });

    try {
      const headers: Record<string, string> = {
        Accept: 'application/json',
        'Cache-Control': 'no-cache',
      };
      let bodyPayload: BodyInit | undefined;
      if (options?.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        bodyPayload = JSON.stringify(options.body);
      }

      const res = await fetch(endpoint, {
        method,
        headers,
        body: bodyPayload,
        cache: 'no-store',
        signal: controller.signal,
      });

      const contentType = res.headers.get('content-type') || '';
      const rawText = await res.text();
      const parsed = parseJsonBody(rawText, contentType, res.status, endpoint);

      if (!parsed.ok) {
        throw parsed.error;
      }

      if (!res.ok) {
        const errMsg =
          typeof parsed.data.error === 'string' && parsed.data.error.trim()
            ? parsed.data.error
            : `Request to ${endpoint} failed (HTTP ${res.status}).`;
        const errCode =
          typeof parsed.data.code === 'string' ? parsed.data.code : `HTTP_${res.status}`;
        throw new ApiRequestError({
          status: res.status,
          code: errCode,
          endpoint,
          message: errMsg,
          details: `HTTP ${res.status} (${errCode}) · Endpoint: ${endpoint}`,
          retryable: res.status >= 500 || res.status === 429 || res.status === 408,
          suggestRefresh: res.status === 404,
        });
      }

      return { status: res.status, data: parsed.data as T };
    } catch (err) {
      if (err instanceof ApiRequestError) throw err;
      if (err instanceof DOMException && err.name === 'AbortError') {
        if (options?.signal?.aborted) {
          throw new ApiRequestError({
            status: 0,
            code: 'ABORTED',
            endpoint,
            message: 'Request cancelled.',
            details: `Aborted by client · Endpoint: ${endpoint}`,
            retryable: true,
          });
        }
        throw new ApiRequestError({
          status: 408,
          code: 'TIMEOUT',
          endpoint,
          message: 'The server took too long to respond. Your job may still be running in the background.',
          details: `Client timeout after ${Math.round(timeoutMs / 1000)}s · Endpoint: ${endpoint}`,
          retryable: true,
        });
      }
      throw new ApiRequestError({
        status: 0,
        code: 'NETWORK_ERROR',
        endpoint,
        message: 'Could not reach the TruthLens backend. Check your connection and retry.',
        details: `${err instanceof Error ? err.message : String(err)} · Endpoint: ${endpoint}`,
        retryable: true,
      });
    } finally {
      window.clearTimeout(timer);
      options?.signal?.removeEventListener('abort', onExternalAbort);
    }
  };

  const promise = run();
  if (dedupeKey) {
    inflightGetRequests.set(dedupeKey, promise);
    void promise.finally(() => {
      inflightGetRequests.delete(dedupeKey);
    });
  }
  return promise;
}

/**
 * Uploads a single file in its own isolated FormData request so multiple-file batches
 * never reuse a previous file, stay under serverless payload caps, and report accurate per-file progress.
 * Accepts both HTTP 200 (synchronous serverless completion) and HTTP 202 (asynchronous pipeline start).
 */
export function uploadSingleFileWithProgress(
  file: File,
  options: {
    onProgress?: (pct: number, loaded: number, total: number) => void;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<{ status: number; analysis: AnalysisRecord; mode?: 'sync' | 'async' }> {
  const endpoint = '/api/analyses/upload';
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    formData.append('files', file, file.name);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', endpoint);
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.timeout = options.timeoutMs ?? 65_000;

    const onAbort = () => xhr.abort();
    if (options.signal) {
      if (options.signal.aborted) {
        reject(
          new ApiRequestError({
            status: 0,
            code: 'CANCELLED',
            endpoint,
            message: 'Upload cancelled before transfer began.',
            details: `File: ${file.name}`,
            retryable: true,
          }),
        );
        return;
      }
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    const cleanup = () => {
      options.signal?.removeEventListener('abort', onAbort);
    };

    xhr.upload.onprogress = (evt) => {
      if (evt.lengthComputable && evt.total > 0) {
        const pct = Math.min(100, Math.round((evt.loaded / evt.total) * 100));
        options.onProgress?.(pct, evt.loaded, evt.total);
      }
    };

    xhr.onload = () => {
      cleanup();
      const contentType = xhr.getResponseHeader('content-type') || '';
      const parsed = parseJsonBody(xhr.responseText || '', contentType, xhr.status, endpoint);
      if (!parsed.ok) {
        reject(parsed.error);
        return;
      }

      const data = parsed.data;
      if (xhr.status >= 200 && xhr.status < 300) {
        const list = Array.isArray(data.analyses) ? (data.analyses as AnalysisRecord[]) : [];
        const single = list[0] ?? (data.analysis as AnalysisRecord | undefined);
        if (single && single.id) {
          resolve({
            status: xhr.status,
            analysis: single,
            mode: data.mode === 'sync' || data.mode === 'async' ? data.mode : undefined,
          });
          return;
        }
        reject(
          new ApiRequestError({
            status: xhr.status,
            code: 'MISSING_ANALYSIS_PAYLOAD',
            endpoint,
            message: 'Upload succeeded, but the server response did not include an analysis record.',
            details: `HTTP ${xhr.status} · Keys returned: ${Object.keys(data).join(', ') || 'none'}`,
            retryable: true,
            suggestRefresh: true,
          }),
        );
        return;
      }

      const errMsg =
        typeof data.error === 'string' && data.error.trim()
          ? data.error
          : xhr.status === 413
            ? 'File exceeds the server upload body limit.'
            : `Upload failed with HTTP ${xhr.status}.`;
      const errCode = typeof data.code === 'string' ? data.code : `HTTP_${xhr.status}`;
      reject(
        new ApiRequestError({
          status: xhr.status,
          code: errCode,
          endpoint,
          message: errMsg,
          details: `HTTP ${xhr.status} (${errCode}) · File: ${file.name} · Endpoint: ${endpoint}`,
          retryable: xhr.status >= 500 || xhr.status === 404 || xhr.status === 429,
          suggestRefresh: xhr.status === 404,
        }),
      );
    };

    xhr.onerror = () => {
      cleanup();
      reject(
        new ApiRequestError({
          status: 0,
          code: 'NETWORK_ERROR',
          endpoint,
          message: 'Network interruption while uploading to TruthLens. Retry when ready.',
          details: `XHR network error · File: ${file.name} · Endpoint: ${endpoint}`,
          retryable: true,
        }),
      );
    };

    xhr.ontimeout = () => {
      cleanup();
      reject(
        new ApiRequestError({
          status: 408,
          code: 'UPLOAD_TIMEOUT',
          endpoint,
          message: 'Upload timed out before the server responded. Please retry.',
          details: `XHR timeout · File: ${file.name} · Endpoint: ${endpoint}`,
          retryable: true,
        }),
      );
    };

    xhr.onabort = () => {
      cleanup();
      reject(
        new ApiRequestError({
          status: 0,
          code: 'CANCELLED',
          endpoint,
          message: 'Transfer cancelled. Your file remains queued and ready to retry.',
          details: `Cancelled by user · File: ${file.name}`,
          retryable: true,
        }),
      );
    };

    xhr.send(formData);
  });
}

// Client-side resilience cache so refreshes or serverless cold starts preserve recent reports
const ANALYSES_CACHE_KEY = 'truthlens_analyses_cache_v1';
const MAX_CACHED_ANALYSES = 25;

export function loadCachedAnalyses(): AnalysisRecord[] {
  try {
    const raw = window.localStorage.getItem(ANALYSES_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AnalysisRecord[]) : [];
  } catch {
    return [];
  }
}

export function saveCachedAnalyses(records: AnalysisRecord[]): void {
  try {
    const trimmed = records.slice(0, MAX_CACHED_ANALYSES);
    window.localStorage.setItem(ANALYSES_CACHE_KEY, JSON.stringify(trimmed));
  } catch {
    // Ignore storage quota errors cleanly
  }
}
