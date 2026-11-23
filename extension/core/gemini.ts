import {
  aiInvalidResponse, aiNotConfigured, aiOffline, aiQuota, aiRejected, aiTimeout, aiUnavailable, ApiError,
} from './errors.ts';

/** JSON-schema subset that Gemini's `responseSchema` understands. */
export type JsonSchema = Record<string, unknown>;

export interface AiRequest<T> {
  system: string;
  prompt: string;
  schema: JsonSchema;
  /** Turns the model's parsed JSON into a clean value; throws if it can't be used. */
  parse: (json: unknown) => T;
}

export interface StructuredAi {
  generate<T>(request: AiRequest<T>): Promise<{ data: T; model: string }>;
}

export interface GeminiSettings {
  apiKey: string;
  model: string;
  fallbackModel: string;
  /** Switch "thinking" off for speed. */
  thinkingOff: boolean;
  timeoutMs: number;
  maxAttempts: number;
}

export const DEFAULT_MODEL = 'gemini-3-flash-preview';
export const DEFAULT_FALLBACK_MODEL = 'gemini-3.1-flash-lite';
export const MODEL_CHOICES = [
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-2.5-flash',
];

export const DEFAULT_GEMINI: Omit<GeminiSettings, 'apiKey'> = {
  model: DEFAULT_MODEL,
  fallbackModel: DEFAULT_FALLBACK_MODEL,
  thinkingOff: true,
  timeoutMs: 35_000, // a slow model is abandoned so the backup model can answer
  maxAttempts: 2,
};

/** Tried after the chosen models if those are overloaded, rate limited or unavailable. */
const EXTRA_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

interface Options {
  fetch?: Fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** Gemini over plain HTTPS. The key goes in a header, never in the URL. */
export class GeminiClient implements StructuredAi {
  private readonly settings: GeminiSettings;
  private readonly fetchImpl: Fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly noThinking = new Set<string>();

  constructor(settings: GeminiSettings, options: Options = {}) {
    this.settings = settings;
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async generate<T>(request: AiRequest<T>): Promise<{ data: T; model: string }> {
    if (!this.settings.apiKey.trim()) throw aiNotConfigured();
    // The chosen model, the chosen backup, then other fast models: one overloaded model shouldn't block you.
    const models = [...new Set([this.settings.model, this.settings.fallbackModel, ...EXTRA_MODELS].filter(Boolean))];
    for (let i = 0; i < models.length; i++) {
      const model = models[i] as string;
      try {
        return { data: await this.callModel(model, request), model };
      } catch (error) {
        const retryable = error instanceof ApiError && [404, 429, 502, 503, 504].includes(error.status ?? 0);
        if (!retryable || i + 1 === models.length) throw error;
      }
    }
    throw aiUnavailable();
  }

  private async callModel<T>(model: string, request: AiRequest<T>): Promise<T> {
    let last: ApiError = aiUnavailable();
    let attempt = 0;
    while (attempt < this.settings.maxAttempts) {
      attempt += 1;
      try {
        const json = await this.post(model, request);
        try {
          return request.parse(json);
        } catch {
          throw aiInvalidResponse();
        }
      } catch (error) {
        if (error instanceof RejectsThinking) {
          this.noThinking.add(model);
          attempt -= 1; // not a real failure: retry straight away
          continue;
        }
        last = error instanceof ApiError ? error : aiUnavailable();
      }
      // A timeout is not retried on the same model (that only doubles the wait): the backup model takes over.
      const retryable = last.status === 503 || (last.status === 502 && last.message.includes('read'));
      if (!retryable || attempt >= this.settings.maxAttempts) break;
      await this.sleep(300 * 2 ** (attempt - 1) + Math.random() * 200);
    }
    throw last;
  }

  private async post(model: string, request: AiRequest<unknown>): Promise<unknown> {
    const generationConfig: Record<string, unknown> = {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: request.schema,
    };
    if (this.settings.thinkingOff && !this.noThinking.has(model)) {
      // Gemini 3 models ignore a zero budget and "think" for a long time; they take a level instead.
      generationConfig.thinkingConfig = /^gemini-3/.test(model) ? { thinkingLevel: 'minimal' } : { thinkingBudget: 0 };
    }
    const body = {
      systemInstruction: { parts: [{ text: request.system }] },
      contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
      generationConfig,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.settings.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.settings.apiKey.trim() },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if ((error as { name?: string })?.name === 'AbortError') throw aiTimeout();
      throw aiOffline();
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw this.translate(response.status, text, model);
    }
    let payload: any;
    try {
      payload = await response.json();
    } catch {
      throw aiInvalidResponse();
    }
    const text: string | undefined = payload?.candidates?.[0]?.content?.parts
      ?.map((p: { text?: string }) => p.text ?? '')
      .join('');
    if (!text) throw aiInvalidResponse('The AI returned an empty response. Please try again.');
    try {
      return JSON.parse(text);
    } catch {
      throw aiInvalidResponse();
    }
  }

  private translate(status: number, text: string, model: string): ApiError | RejectsThinking {
    if (status === 400 && this.settings.thinkingOff && !this.noThinking.has(model) && /thinking/i.test(text)) {
      return new RejectsThinking();
    }
    if (status === 429) {
      return aiQuota(/perday/i.test(text.replace(/[_\s]/g, '')));
    }
    if (status === 400 && /api key/i.test(text)) {
      return aiRejected('Gemini rejected the API key. Check it in the AI section.');
    }
    if (status === 401 || status === 403) {
      return aiRejected('Gemini rejected the API key. Check it in the AI section.');
    }
    if (status === 404) {
      return aiRejected('That Gemini model wasn’t found. Pick another model in the AI section.');
    }
    if (status === 408 || status >= 500) {
      let reason = '';
      try {
        reason = String(JSON.parse(text)?.error?.message ?? '').slice(0, 160);
      } catch {
        reason = text.slice(0, 160);
      }
      return aiUnavailable(`${model}, HTTP ${status}${reason ? `: ${reason.replace(/\s+/g, ' ').trim()}` : ''}`);
    }
    return aiRejected();
  }
}

class RejectsThinking extends ApiError {
  constructor() {
    super('http', 'thinking setting rejected', 400);
  }
}
