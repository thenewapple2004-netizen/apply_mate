/** Saved answers (reused across applications) and the rules about what may never be saved. */
import type { Ctx } from './ctx.ts';
import { requireProfile } from './profiles.ts';
import { profileKey } from './store.ts';
import { norm, nowIso } from './text.ts';
import type { FormField, PreparedAnswer, SavedAnswer } from './types.ts';

// Answers that must never be stored for reuse.
export const CONSENT = /\b(agree|consent|certify|acknowledge|accept|terms|privacy|policy|declare|attest)\b/i;
export const SENSITIVE =
  /\b(gender|sex|race|racial|ethnic\w*|hispanic|latin[oax]|veteran|disabilit\w*|sexual orientation|pronouns?|age range|date of birth|religio\w*|marital|criminal|conviction|salary|compensation|pay expectations?|authori[sz]ed|authori[sz]ation|legally (able|eligible|entitled|permitted)|right to work|eligible to work|work permit|work eligibility|sponsor\w*|visa|citizen\w*|nationality|immigration)\b/i;

/** Consent/declarations and personal or negotiable questions: answered by the user each time. */
export const isSensitive = (question: string): boolean => CONSENT.test(question) || SENSITIVE.test(question);

/** Normalise a question so small wording/formatting differences still match. */
export function questionKey(question: string): string {
  const text = question.replace(/\(.*?\)|\*/g, ' ');
  return norm(text).slice(0, 300);
}

/** The exact option value an answer refers to, matched by value or label. */
export function matchOption(field: FormField, raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const wanted = norm(raw);
  for (const option of field.options) {
    if (raw === option.value || wanted === norm(option.value) || wanted === norm(option.label)) return option.value;
  }
  return null;
}

/** A prepared answer with every field filled in. */
export function answer(fieldId: string, partial: Partial<PreparedAnswer> & { source: PreparedAnswer['source'] }): PreparedAnswer {
  return {
    field_id: fieldId,
    value: null,
    values: [],
    note: null,
    suggestions: [],
    cached: false,
    needs_approval: false,
    approved: false,
    preference: null,
    ...partial,
  };
}

const key = (profileId: string): string => profileKey(profileId, 'answers');

export async function listAnswers(ctx: Ctx, profileId: string): Promise<SavedAnswer[]> {
  await requireProfile(ctx, profileId);
  const all = (await ctx.store.get<SavedAnswer[]>(key(profileId))) ?? [];
  return [...all].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

/** Insert or update answers by question. Sensitive and consent questions are skipped. Returns how many were stored. */
export async function saveAnswers(ctx: Ctx, profileId: string, items: { question: string; answer: string }[]): Promise<number> {
  await requireProfile(ctx, profileId);
  const rows = new Map<string, { question: string; answer: string }>();
  for (const { question, answer: text } of items) {
    const k = questionKey(question);
    if (k && text.trim() && !isSensitive(question)) rows.set(k, { question: question.trim().slice(0, 1000), answer: text.trim() });
  }
  if (!rows.size) return 0;
  const now = nowIso();
  await ctx.store.update<SavedAnswer[]>(key(profileId), (all) => {
    const byKey = new Map((all ?? []).map((a) => [a.question_key, a]));
    for (const [k, row] of rows) {
      const old = byKey.get(k);
      byKey.set(k, { question_key: k, question: row.question, answer: row.answer, created_at: old?.created_at ?? now, updated_at: now });
    }
    return [...byKey.values()];
  });
  return rows.size;
}
