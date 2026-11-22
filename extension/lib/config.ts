/**
 * Backend location. Override at build time by setting WXT_API_BASE_URL in
 * extension/.env (for example WXT_API_BASE_URL=http://localhost:8000).
 * If you change the host or port, also update host_permissions in wxt.config.ts.
 *
 * Only public settings belong here: everything in this file ships inside the
 * extension and is readable by anyone who installs it.
 */
export const API_BASE_URL: string =
  import.meta.env?.WXT_API_BASE_URL ?? 'http://127.0.0.1:8000';

/** How long a request may take before it is abandoned. */
export const API_TIMEOUT_MS = 5000;
