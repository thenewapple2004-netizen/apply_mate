/**
 * The one error type used by all the logic in core/. It keeps the shape the UI already
 * understands (`kind`, `status`, `fieldErrors`), so screens that show field errors or
 * "not found" messages work unchanged now that nothing talks to a server.
 *
 * - `network`: Google's AI service couldn't be reached (offline, blocked...)
 * - `timeout`: no answer in time
 * - `http`: a rule was broken or something wasn't found; `status` says which (404, 422...)
 * - `invalid-response`: the AI's answer couldn't be read
 */
export type ApiErrorKind = 'network' | 'timeout' | 'http' | 'invalid-response';

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status?: number;
  /** Per-field validation messages, keyed by field name or path ("work_experience.0.company"). */
  readonly fieldErrors: Record<string, string>;

  constructor(kind: ApiErrorKind, message: string, status?: number, fieldErrors: Record<string, string> = {}) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
    this.fieldErrors = fieldErrors;
  }
}

export const notFound = (what: string): ApiError => new ApiError('http', `${what} not found`, 404);

export const invalid = (message: string, fieldErrors: Record<string, string> = {}): ApiError =>
  new ApiError('http', message, 422, fieldErrors);

// ---- AI errors: the same messages and status codes the old backend used ----

export const aiNotConfigured = (): ApiError =>
  new ApiError('http', 'AI isn’t set up yet. Add your free Gemini API key in the AI section below.', 503);

export const aiQuota = (daily = false): ApiError =>
  new ApiError(
    'http',
    daily
      ? 'The Gemini daily quota for this model is used up (free plans have a small daily limit). It resets within 24 hours: try another model in AI settings, or use a paid plan.'
      : 'The Gemini quota or rate limit has been reached. Wait a minute and try again, or check your Gemini plan.',
    429,
  );

export const aiUnavailable = (): ApiError =>
  new ApiError('http', 'The AI service is temporarily unavailable. Please try again shortly.', 503);

export const aiTimeout = (): ApiError =>
  new ApiError('http', 'The AI service took too long to respond. Please try again.', 504);

export const aiRejected = (message = 'The AI service rejected the request.'): ApiError =>
  new ApiError('http', message, 502);

export const aiInvalidResponse = (message = 'The AI returned a response that couldn’t be read. Please try again.'): ApiError =>
  new ApiError('http', message, 502);

export const aiOffline = (): ApiError =>
  new ApiError('network', 'Couldn’t reach Google’s AI service. Check your internet connection.');

/** True for errors worth retrying or falling back from. */
export const isTransientAiError = (e: unknown): boolean =>
  e instanceof ApiError && (e.status === 503 || e.status === 504 || e.kind === 'network');
export const isQuotaError = (e: unknown): boolean => e instanceof ApiError && e.status === 429;
