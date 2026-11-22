/** Small text helpers shared by the logic in core/. */

/** Lowercase letters and digits separated by single spaces (accents removed). */
export function norm(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Collapse any run of whitespace to one space. */
export const collapse = (text: string): string => text.split(/\s+/).filter(Boolean).join(' ');

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const uuid = (): string => crypto.randomUUID();
export const nowIso = (): string => new Date().toISOString();
