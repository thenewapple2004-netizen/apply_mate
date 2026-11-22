import { ApiError } from '../core/errors.ts';

export { ApiError };
export type { ApiErrorKind } from '../core/errors.ts';

/**
 * A short, user-facing explanation of any error. Unexpected (non-API) errors
 * keep their own message so the cause is visible instead of a generic text.
 */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message) return `Unexpected error: ${error.message}`;
  return 'Something went wrong.';
}
