import { collapse } from './text.ts';

export type Errors = Record<string, string>;

/** Trim; empty becomes null. Multi-line text keeps its line breaks. */
export function blankToNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.includes('\n') ? value.trim() : collapse(value);
  return text === '' ? null : text;
}

/** Trim items, drop blanks/nulls and case-insensitive duplicates, keep order. */
export function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const text = collapse(item);
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    out.push(text);
  }
  return out;
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE = /^\+?[0-9 ()\-.]{5,40}$/;

export const checkEmail = (v: string): string | null => (EMAIL.test(v) ? null : 'must be a valid email address');
export const checkPhone = (v: string): string | null =>
  PHONE.test(v) ? null : 'may contain only digits, spaces, + ( ) - and .';

export function checkLinkedin(value: string): string | null {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if ((url.protocol === 'http:' || url.protocol === 'https:') && (host === 'linkedin.com' || host.endsWith('.linkedin.com'))) {
      return null;
    }
  } catch {
    // fall through
  }
  return 'must be a linkedin.com URL starting with https://';
}

export const tooLong = (max: number): string => `must be at most ${max} characters`;

/** Check an optional text field: returns the cleaned value and records an error if it breaks a rule. */
export function optionalText(
  errors: Errors,
  field: string,
  value: unknown,
  max: number,
  check?: (v: string) => string | null,
): string | null {
  if (value !== undefined && value !== null && typeof value !== 'string') {
    errors[field] = 'must be text';
    return null;
  }
  const text = blankToNull(value);
  if (text === null) return null;
  if (text.length > max) errors[field] = tooLong(max);
  else {
    const problem = check?.(text);
    if (problem) errors[field] = problem;
  }
  return text;
}

/** A list of short texts (cleaned), with limits on item length and count. */
export function textList(errors: Errors, field: string, value: unknown, maxItems: number, maxLength: number): string[] {
  if (value !== undefined && value !== null && !Array.isArray(value)) {
    errors[field] = 'must be a list';
    return [];
  }
  const items = cleanList(value);
  if (items.length > maxItems) errors[field] = `must have at most ${maxItems} items`;
  else if (items.some((i) => i.length > maxLength)) errors[field] = `each item must be at most ${maxLength} characters`;
  return items;
}

/** Report keys that aren't expected (the UI only sends known fields). */
export function rejectUnknown(errors: Errors, input: Record<string, unknown>, allowed: readonly string[], prefix = ''): void {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) errors[`${prefix}${key}`] = 'is not allowed';
  }
}

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
