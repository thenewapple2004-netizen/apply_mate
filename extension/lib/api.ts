import { API_BASE_URL, API_TIMEOUT_MS } from './config.ts';

/**
 * Why a request failed:
 * - `network`: the backend could not be reached (not running, wrong port, ...)
 * - `timeout`: no response within the timeout
 * - `http`: the backend answered with a non-2xx status
 * - `invalid-response`: the response body was not valid JSON
 */
export type ApiErrorKind = 'network' | 'timeout' | 'http' | 'invalid-response';

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  /** HTTP status, when the backend answered. */
  readonly status?: number;
  /** Per-field validation messages from a 422 response, keyed by field name. */
  readonly fieldErrors: Record<string, string>;

  constructor(
    kind: ApiErrorKind,
    message: string,
    status?: number,
    fieldErrors: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
    this.fieldErrors = fieldErrors;
  }
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RequestOptions {
  method?: HttpMethod;
  /** Sent as JSON. */
  body?: unknown;
  /** Abort the request early, e.g. when the popup closes. */
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Call the backend and return the parsed JSON body (undefined for 204 No Content).
 * Throws ApiError on any failure; rethrows the caller's own abort unchanged.
 */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal, timeoutMs = API_TIMEOUT_MS } = options;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(new URL(path, API_BASE_URL), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: combined,
    });
  } catch (error) {
    if (signal?.aborted) throw error; // cancelled by the caller: not an API failure
    if (timeoutSignal.aborted) {
      throw new ApiError('timeout', `No response within ${timeoutMs / 1000}s`);
    }
    throw new ApiError('network', 'Could not reach the backend');
  }

  if (!response.ok) throw await toHttpError(response);
  if (response.status === 204) return undefined as T;

  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError('invalid-response', 'Backend returned an invalid response', response.status);
  }
}

/** GET a JSON resource from the backend. Throws ApiError on any failure. */
export function apiGet<T>(path: string, options: Omit<RequestOptions, 'method' | 'body'> = {}) {
  return apiRequest<T>(path, { ...options, method: 'GET' });
}

interface ValidationIssue {
  loc?: (string | number)[];
  msg?: string;
}

export interface UploadOptions {
  /** Called with 0–1 as the request body is sent. */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * POST multipart form data, reporting upload progress (fetch can't).
 * Errors are reported exactly like apiRequest's.
 */
export function apiUpload<T>(path: string, form: FormData, options: UploadOptions = {}): Promise<T> {
  const { onProgress, signal, timeoutMs = 60_000 } = options;
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open('POST', new URL(path, API_BASE_URL));
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.timeout = timeoutMs;

    const onAbort = () => xhr.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const done = () => signal?.removeEventListener('abort', onAbort);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () => {
      done();
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(errorFromBody(xhr.status, xhr.responseText));
        return;
      }
      try {
        resolve(JSON.parse(xhr.responseText) as T);
      } catch {
        reject(new ApiError('invalid-response', 'Backend returned an invalid response', xhr.status));
      }
    };
    xhr.onerror = () => {
      done();
      reject(new ApiError('network', 'Could not reach the backend'));
    };
    xhr.ontimeout = () => {
      done();
      reject(new ApiError('timeout', `No response within ${timeoutMs / 1000}s`));
    };
    xhr.onabort = () => {
      done();
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    xhr.send(form);
  });
}

async function toHttpError(response: Response): Promise<ApiError> {
  let body = '';
  try {
    body = await response.text();
  } catch {
    // Unreadable body: fall through to the generic message.
  }
  return errorFromBody(response.status, body);
}

/** Turns FastAPI's error body ({detail: string} or {detail: [...issues]}) into an ApiError. */
function errorFromBody(status: number, body: string): ApiError {
  let detail: unknown;
  try {
    detail = (JSON.parse(body) as { detail?: unknown }).detail;
  } catch {
    // Non-JSON error body: fall through to the generic message.
  }

  if (typeof detail === 'string') {
    return new ApiError('http', detail, status);
  }

  if (Array.isArray(detail)) {
    const fieldErrors: Record<string, string> = {};
    const general: string[] = [];
    for (const issue of detail as ValidationIssue[]) {
      const msg = (issue.msg ?? 'Invalid value').replace(/^Value error, /, '');
      const loc = issue.loc ?? [];
      // Body fields arrive as ["body", "<field>"]; anything else is a general error.
      if (loc[0] === 'body' && typeof loc[1] === 'string') {
        fieldErrors[loc[1]] ??= msg;
      } else {
        general.push(msg);
      }
    }
    const message = general[0] ?? 'Please correct the highlighted fields';
    return new ApiError('http', message, status, fieldErrors);
  }

  return new ApiError('http', `Backend returned HTTP ${status}`, status);
}
