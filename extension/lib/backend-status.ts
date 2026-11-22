import { ApiError, apiGet } from './api.ts';

export type ConnectionState = 'connecting' | 'connected' | 'offline' | 'error';

export interface BackendStatus {
  state: ConnectionState;
  /** Short, user-facing explanation for `offline` and `error`. */
  detail?: string;
}

interface HealthResponse {
  status: string;
}

/** Checks the API (/health) and its database (/health/db). */
export async function checkBackendStatus(signal?: AbortSignal): Promise<BackendStatus> {
  try {
    const api = await apiGet<HealthResponse>('/health', { signal });
    if (api.status !== 'ok') {
      return { state: 'error', detail: 'Backend reported a problem' };
    }
  } catch (error) {
    return toStatus(error, 'Backend');
  }

  try {
    await apiGet<HealthResponse>('/health/db', { signal });
  } catch (error) {
    if (error instanceof ApiError && error.status === 503) {
      return { state: 'error', detail: 'Database unavailable' };
    }
    return toStatus(error, 'Database check');
  }

  return { state: 'connected' };
}

function toStatus(error: unknown, what: string): BackendStatus {
  if (!(error instanceof ApiError)) throw error; // e.g. aborted by the caller
  switch (error.kind) {
    case 'network':
      return { state: 'offline', detail: 'Is the backend running on port 8000?' };
    case 'timeout':
      return { state: 'error', detail: `${what} timed out` };
    default:
      return { state: 'error', detail: error.message };
  }
}
