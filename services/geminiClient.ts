import { GoogleGenAI, ThinkingLevel, type Schema } from '@google/genai';

// Approved non-deprecated models (only configured/verified aliases are permitted)
const ALLOWED_FALLBACK_MODELS = new Set<string>([
  'gemini-4-hydrogen',
  'gemini-3.1-flash-lite',
]);

function resolveApprovedModel(envValue: string | undefined, defaultModel: string): string {
  const candidate = envValue?.trim();
  if (candidate && ALLOWED_FALLBACK_MODELS.has(candidate)) {
    return candidate;
  }
  return defaultModel;
}

export const GEMINI_FORENSIC_MODEL = resolveApprovedModel(
  process.env.GEMINI_MODEL,
  'gemini-4-hydrogen',
);

export const GEMINI_FALLBACK_MODEL = resolveApprovedModel(
  process.env.GEMINI_FALLBACK_MODEL,
  'gemini-3.1-flash-lite',
);

export interface GeminiRetryPolicy {
  maxRetriesPerModel: number;
  baseDelayMs: number;
  maxDelayMs: number;
  defaultTimeoutMs: number;
}

const IS_SERVERLESS_ENV = Boolean(
  process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY,
);

export const GEMINI_RETRY_POLICY: GeminiRetryPolicy = {
  maxRetriesPerModel: Math.max(
    1,
    Math.min(
      3,
      Number.parseInt(process.env.GEMINI_MAX_RETRIES ?? (IS_SERVERLESS_ENV ? '1' : '2'), 10) ||
        (IS_SERVERLESS_ENV ? 1 : 2),
    ),
  ),
  baseDelayMs: Math.max(
    300,
    Math.min(5000, Number.parseInt(process.env.GEMINI_RETRY_BASE_MS ?? '700', 10) || 700),
  ),
  maxDelayMs: 6_000,
  defaultTimeoutMs: Math.max(
    10_000,
    Math.min(
      60_000,
      Number.parseInt(process.env.GEMINI_TIMEOUT_MS ?? (IS_SERVERLESS_ENV ? '20000' : '32000'), 10) ||
        (IS_SERVERLESS_ENV ? 20_000 : 32_000),
    ),
  ),
};

export type GeminiErrorCode =
  | 'API_KEY_UNAVAILABLE'
  | 'GEMINI_HIGH_DEMAND_503'
  | 'GEMINI_RATE_LIMIT_429'
  | 'GEMINI_MODEL_UNAVAILABLE'
  | 'GEMINI_NETWORK_ERROR'
  | 'GEMINI_API_FAILURE'
  | 'PROCESSING_TIMEOUT'
  | 'INVALID_RESPONSE';

export class GeminiServiceError extends Error {
  code: GeminiErrorCode;
  statusCode: number;
  retryable: boolean;
  attemptsMade: number;

  constructor(
    message: string,
    code: GeminiErrorCode,
    statusCode = 502,
    retryable = false,
    attemptsMade = 1,
  ) {
    super(message);
    this.name = 'GeminiServiceError';
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = retryable;
    this.attemptsMade = attemptsMade;
  }
}

export function isGeminiConfigured(): boolean {
  const key = process.env.GEMINI_API_KEY?.trim();
  return Boolean(key && key !== 'MY_GEMINI_API_KEY');
}

export function getConfiguredGeminiModels(): string[] {
  const models = [GEMINI_FORENSIC_MODEL];
  if (GEMINI_FALLBACK_MODEL && GEMINI_FALLBACK_MODEL !== GEMINI_FORENSIC_MODEL) {
    models.push(GEMINI_FALLBACK_MODEL);
  }
  return models;
}

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new GeminiServiceError(
      'Gemini API key is not configured on the server. Set GEMINI_API_KEY in Settings > Secrets.',
      'API_KEY_UNAVAILABLE',
      503,
      false,
      0,
    );
  }

  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export interface InlineMediaPart {
  inlineData: {
    mimeType: string;
    data: string;
  };
}

export interface TextPart {
  text: string;
}

export type ForensicContentPart = InlineMediaPart | TextPart;

export interface GeminiRetryEvent {
  model: string;
  nextModel: string;
  attempt: number;
  totalAttempts: number;
  delayMs: number;
  reason: string;
  httpStatus?: number;
}

export interface GeminiCallMeta<T> {
  data: T;
  modelUsed: string;
  attemptsMade: number;
  usedFallbackModel: boolean;
}

const STRICT_FORENSIC_SYSTEM_INSTRUCTION = [
  'You are a careful, calibrated digital forensics analyst assisting TruthLens.',
  'STRICT EVIDENTIARY & ANTI-FALSE-POSITIVE RULES:',
  '1. Never claim 100% certainty or definitive proof of AI generation or human authorship.',
  '2. Never invent or fabricate watermarks, logos, EXIF fields, C2PA credentials, camera models, timestamps, or detector outputs that are not directly present in the media or supplied technical evidence.',
  '3. If a signal or attribute is absent or cannot be determined from the provided media, explicitly state "Not available" or "Inconclusive".',
  '4. Clearly distinguish between directly observed visual/acoustic/textual indicators and interpretive explanations.',
  '5. Do NOT treat consistent facial landmarks, natural temporal stability, high inter-frame histogram similarity, stable lighting, consistent backgrounds, smartphone HDR/EIS/beautification, or social-media re-encoding as evidence of AI generation — these are normal traits of authentic camera-recorded human videos.',
  '6. Do NOT treat missing metadata, stripped EXIF/container tags, or absence of AI watermarks/C2PA as proof of either AI generation or authenticity; missing metadata and absent watermarks are neutral.',
  '7. Only assign elevated AI-likelihood anomaly scores (>= 60/100) when concrete, directly observable synthetic-generation or manipulation artifacts are present (e.g., warping anatomy/text, face-swap blending seams, temporal identity drift, unnatural morphing physics, or verified AI provenance/watermarks).',
  '8. Return concise, precise JSON strictly adhering to the requested response schema.',
].join('\n');

function classifyUpstreamError(error: unknown, attemptsMade: number): GeminiServiceError {
  if (error instanceof GeminiServiceError) {
    return new GeminiServiceError(
      error.message,
      error.code,
      error.statusCode,
      error.retryable,
      attemptsMade,
    );
  }

  const rawMsg = error instanceof Error ? error.message : String(error);
  const lower = rawMsg.toLowerCase();

  if (
    lower.includes('api_key_invalid') ||
    lower.includes('permission_denied') ||
    lower.includes('"code":403') ||
    lower.includes('401')
  ) {
    return new GeminiServiceError(
      'Gemini API authentication failed. Verify GEMINI_API_KEY in server configuration.',
      'API_KEY_UNAVAILABLE',
      403,
      false,
      attemptsMade,
    );
  }

  if (
    lower.includes('503') ||
    lower.includes('unavailable') ||
    lower.includes('high demand') ||
    lower.includes('overloaded') ||
    lower.includes('service unavailable')
  ) {
    return new GeminiServiceError(
      'HTTP 503 — Gemini model is temporarily experiencing high demand (UNAVAILABLE).',
      'GEMINI_HIGH_DEMAND_503',
      503,
      true,
      attemptsMade,
    );
  }

  if (
    lower.includes('429') ||
    lower.includes('resource_exhausted') ||
    lower.includes('rate limit') ||
    lower.includes('quota')
  ) {
    return new GeminiServiceError(
      'HTTP 429 — Gemini API rate limit or quota reached (RESOURCE_EXHAUSTED).',
      'GEMINI_RATE_LIMIT_429',
      429,
      true,
      attemptsMade,
    );
  }

  if (
    lower.includes('fetch failed') ||
    lower.includes('econnreset') ||
    lower.includes('etimedout') ||
    lower.includes('enotfound') ||
    lower.includes('socket hang up') ||
    lower.includes('network')
  ) {
    return new GeminiServiceError(
      `Network error communicating with Gemini API: ${rawMsg.slice(0, 140)}`,
      'GEMINI_NETWORK_ERROR',
      502,
      true,
      attemptsMade,
    );
  }

  if (
    lower.includes('404') ||
    lower.includes('not_found') ||
    lower.includes('is not found') ||
    lower.includes('not supported for generatecontent')
  ) {
    return new GeminiServiceError(
      `HTTP 404 — Requested Gemini model unavailable (${rawMsg.slice(0, 140)}). Falling back to alternative configured model.`,
      'GEMINI_MODEL_UNAVAILABLE',
      404,
      true,
      attemptsMade,
    );
  }

  if (lower.includes('500') || lower.includes('502') || lower.includes('504') || lower.includes('internal')) {
    return new GeminiServiceError(
      `Temporary upstream Gemini server error: ${rawMsg.slice(0, 160)}`,
      'GEMINI_API_FAILURE',
      502,
      true,
      attemptsMade,
    );
  }

  return new GeminiServiceError(
    `Gemini multimodal analysis failed: ${rawMsg.slice(0, 200)}`,
    'GEMINI_API_FAILURE',
    502,
    false,
    attemptsMade,
  );
}

function computeJitteredBackoffMs(retryIndex: number, baseDelayMs: number, maxDelayMs: number): number {
  const exponential = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, retryIndex));
  // Equal-to-full jitter between 60% and 120% of exponential delay to prevent thundering herds
  const jitterFactor = 0.6 + Math.random() * 0.6;
  return Math.round(Math.min(maxDelayMs, exponential * jitterFactor));
}

function parseStrictJsonResponse<T>(rawText: string): T {
  const trimmed = rawText.trim();
  if (!trimmed) {
    throw new GeminiServiceError(
      'Gemini returned an empty forensic analysis payload.',
      'INVALID_RESPONSE',
      502,
      true,
    );
  }

  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // Strip markdown fences or leading/trailing commentary if present
    const cleaned = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    try {
      return JSON.parse(cleaned) as T;
    } catch {
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          return JSON.parse(match[0]) as T;
        } catch {
          // Fall through
        }
      }
      throw new GeminiServiceError(
        'Gemini returned malformed JSON that could not be parsed.',
        'INVALID_RESPONSE',
        502,
        true,
      );
    }
  }
}

type TestInvokeHandler = (
  model: string,
  attemptNumber: number,
  options: { responseSchema: Schema },
) => Promise<string>;

let globalTestInvokeOverride: TestInvokeHandler | null = null;

/** Test-only hook for deterministic HTTP 503/429 integration tests (inactive in production). */
export function __setGeminiTestOverride(handler: TestInvokeHandler | null): void {
  globalTestInvokeOverride = handler;
}

export async function runStructuredGeminiAnalysisWithMeta<T>(options: {
  parts: ForensicContentPart[];
  responseSchema: Schema;
  systemInstruction?: string;
  thinkingLevel?: ThinkingLevel;
  timeoutMs?: number;
  maxRetriesPerModel?: number;
  baseDelayMs?: number;
  onRetry?: (event: GeminiRetryEvent) => void;
  /** Test-only override hook for deterministic unit/integration testing of 503/429 handling */
  __testInvokeOverride?: (model: string, attemptNumber: number) => Promise<string>;
}): Promise<GeminiCallMeta<T>> {
  const activeOverride = options.__testInvokeOverride
    ? (m: string, a: number) => options.__testInvokeOverride!(m, a)
    : globalTestInvokeOverride
      ? (m: string, a: number) => globalTestInvokeOverride!(m, a, { responseSchema: options.responseSchema })
      : null;

  const ai = activeOverride ? null : getGeminiClient();
  const rawTimeout = options.timeoutMs ?? GEMINI_RETRY_POLICY.defaultTimeoutMs;
  const timeoutMs = IS_SERVERLESS_ENV
    ? Math.min(rawTimeout, 20_000)
    : Math.min(Math.max(rawTimeout, 28_000), 45_000);
  const maxRetriesPerModel = options.maxRetriesPerModel ?? GEMINI_RETRY_POLICY.maxRetriesPerModel;
  const baseDelayMs = options.baseDelayMs ?? GEMINI_RETRY_POLICY.baseDelayMs;
  const candidateModels = getConfiguredGeminiModels();

  // Interleave primary and fallback models so a stalled/503 primary immediately fails over on attempt 2
  // instead of waiting for two consecutive full timeouts on the same model.
  const attemptPlan: string[] = [];
  for (let r = 0; r < maxRetriesPerModel; r++) {
    for (const model of candidateModels) {
      attemptPlan.push(model);
    }
  }
  const unavailableModels = new Set<string>();

  let lastClassified: GeminiServiceError | null = null;
  let attemptsMade = 0;

  for (let idx = 0; idx < attemptPlan.length; idx++) {
    const modelName = attemptPlan[idx];
    if (unavailableModels.has(modelName)) continue;
    attemptsMade += 1;

    try {
      let rawText: string;

      if (activeOverride) {
        rawText = await activeOverride(modelName, attemptsMade);
      } else {
        const controller = new AbortController();
        const config: Record<string, unknown> = {
          systemInstruction: options.systemInstruction
            ? `${STRICT_FORENSIC_SYSTEM_INSTRUCTION}\n\n${options.systemInstruction}`
            : STRICT_FORENSIC_SYSTEM_INSTRUCTION,
          responseMimeType: 'application/json',
          responseSchema: options.responseSchema,
          abortSignal: controller.signal,
        };
        if (modelName === 'gemini-4-hydrogen') {
          config.thinkingConfig = {
            thinkingLevel: options.thinkingLevel ?? ThinkingLevel.LOW,
          };
        } else if (modelName === 'gemini-3.1-flash-lite') {
          config.thinkingConfig = {
            thinkingLevel: ThinkingLevel.MINIMAL,
          };
        }

        const callPromise = ai!.models.generateContent({
          model: modelName,
          contents: { parts: options.parts },
          config,
        });

        let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            controller.abort();
            reject(
              new GeminiServiceError(
                `Gemini request (${modelName}) timed out after ${Math.round(timeoutMs / 1000)}s.`,
                'PROCESSING_TIMEOUT',
                504,
                true,
                attemptsMade,
              ),
            );
          }, timeoutMs);
        });

        try {
          const response = await Promise.race([callPromise, timeoutPromise]);
          rawText = response.text ?? '';
        } finally {
          if (timeoutHandle) clearTimeout(timeoutHandle);
        }
      }

      const parsed = parseStrictJsonResponse<T>(rawText);
      return {
        data: parsed,
        modelUsed: modelName,
        attemptsMade,
        usedFallbackModel: modelName !== candidateModels[0],
      };
    } catch (error) {
      const classified = classifyUpstreamError(error, attemptsMade);
      lastClassified = classified;

      // Never retry authentication/configuration errors
      if (!classified.retryable) {
        throw classified;
      }

      // If a specific model returned 404 NOT_FOUND, skip any remaining attempts on that model
      if (classified.code === 'GEMINI_MODEL_UNAVAILABLE') {
        unavailableModels.add(modelName);
      }

      // Find next viable attempt in plan
      let nextModel: string | null = null;
      for (let j = idx + 1; j < attemptPlan.length; j++) {
        if (!unavailableModels.has(attemptPlan[j])) {
          nextModel = attemptPlan[j];
          break;
        }
      }
      if (!nextModel) {
        break;
      }

      const switchingModel = nextModel !== modelName;
      const delayMs = switchingModel
        ? Math.min(800, computeJitteredBackoffMs(0, baseDelayMs, GEMINI_RETRY_POLICY.maxDelayMs))
        : computeJitteredBackoffMs(idx, baseDelayMs, GEMINI_RETRY_POLICY.maxDelayMs);

      options.onRetry?.({
        model: modelName,
        nextModel,
        attempt: attemptsMade,
        totalAttempts: attemptPlan.length,
        delayMs,
        reason: classified.message,
        httpStatus: classified.statusCode,
      });

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw (
    lastClassified ??
    new GeminiServiceError(
      'Gemini multimodal analysis failed after exhausting configured retries.',
      'GEMINI_API_FAILURE',
      502,
      true,
      attemptsMade,
    )
  );
}

export async function runStructuredGeminiAnalysis<T>(options: {
  parts: ForensicContentPart[];
  responseSchema: Schema;
  systemInstruction?: string;
  thinkingLevel?: ThinkingLevel;
  timeoutMs?: number;
  maxRetriesPerModel?: number;
  onRetry?: (event: GeminiRetryEvent) => void;
}): Promise<T> {
  const result = await runStructuredGeminiAnalysisWithMeta<T>(options);
  return result.data;
}
