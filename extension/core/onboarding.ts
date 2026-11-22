/**
 * Onboarding: profile -> resume -> review -> complete.
 *
 * The step is derived from saved data, so reopening the extension never repeats finished steps:
 * - no resume yet           -> "resume"
 * - no confirmed CV details -> "review"
 * - otherwise               -> "complete" (a pending AI draft still offers a review)
 */
import type { Ctx } from './ctx.ts';
import { CONTACT_FIELDS, cleanCv, detailsToData, findDetails, saveDetails, storedAnalyses } from './cv.ts';
import { getProfile, updateProfile } from './profiles.ts';
import { listResumes } from './resumes.ts';
import { norm } from './text.ts';
import type {
  CVData, ContactField, OnboardingState, Profile, ReviewForm, ReviewSubmission, Section, StoredAnalysis,
} from './types.ts';
import { EMPTY_CV } from './types.ts';
import { isObject } from './validation.ts';

const SECTIONS: Section[] = ['summary', 'skills', 'technologies', 'work_experience', 'education', 'projects', 'certifications'];
const LIST_SECTIONS = ['skills', 'technologies'] as const;
const ENTRY_SECTIONS = ['work_experience', 'education', 'projects', 'certifications'] as const;

type Entry = Record<string, unknown>;

/** Identity of a CV entry, used to recognise items that are already confirmed. */
function entryKey(section: (typeof ENTRY_SECTIONS)[number], entry: Entry): string {
  const n = (k: string): string => norm(typeof entry[k] === 'string' ? (entry[k] as string) : '');
  let parts: string[];
  if (section === 'work_experience') parts = [n('company'), n('title'), n('start_date')];
  else if (section === 'education') parts = [n('institution'), n('degree')];
  else parts = [n('name')];
  // An entry with no identifying text at all is compared by its full content.
  return parts.some(Boolean) ? JSON.stringify(parts) : `raw:${JSON.stringify(entry)}`;
}

function newItems<T>(section: (typeof LIST_SECTIONS)[number] | (typeof ENTRY_SECTIONS)[number], candidates: T[], confirmed: T[]): T[] {
  if ((LIST_SECTIONS as readonly string[]).includes(section)) {
    const known = new Set((confirmed as string[]).map(norm));
    return candidates.filter((item) => !known.has(norm(item as string)));
  }
  const s = section as (typeof ENTRY_SECTIONS)[number];
  const known = new Set((confirmed as Entry[]).map((e) => entryKey(s, e)));
  return candidates.filter((item) => !known.has(entryKey(s, item as Entry)));
}

export async function currentResume(ctx: Ctx, profileId: string) {
  const items = await listResumes(ctx, profileId);
  const primary = items.find((r) => r.is_primary);
  return { resume: primary ?? items[items.length - 1] ?? null, count: items.length };
}

export function buildReview(profile: Profile, confirmed: CVData | null, draft: StoredAnalysis | null): ReviewForm {
  const suggestion = draft ? draft.data : EMPTY_CV;
  const suggested = draft?.contact ?? {};
  const contactFields = CONTACT_FIELDS.filter((f) => !profile[f]);
  const contact: ReviewForm['contact'] = {};
  for (const f of contactFields) contact[f] = suggested[f] ?? null;
  const base = {
    contact_fields: contactFields,
    contact,
    source_analysis_id: draft?.id ?? null,
    warnings: draft ? [...draft.warnings] : [],
  };

  if (!confirmed) return { ...base, sections: [...SECTIONS], cv: suggestion };

  const filtered: CVData = { ...EMPTY_CV, summary: confirmed.summary ? null : suggestion.summary };
  const sections: Section[] = confirmed.summary ? [] : ['summary'];
  for (const section of [...LIST_SECTIONS, ...ENTRY_SECTIONS]) {
    const fresh = newItems(section, suggestion[section] as unknown[], confirmed[section] as unknown[]);
    (filtered as unknown as Record<string, unknown>)[section] = fresh;
    if (fresh.length || !confirmed[section].length) sections.push(section);
  }
  return { ...base, sections: SECTIONS.filter((s) => sections.includes(s)), cv: filtered };
}

export async function getState(ctx: Ctx, profileId: string): Promise<OnboardingState> {
  const profile = await getProfile(ctx, profileId);
  const { resume, count } = await currentResume(ctx, profileId);
  const details = await findDetails(ctx, profileId);
  const confirmed = details ? detailsToData(details) : null;
  const analysis = resume ? ((await storedAnalyses(ctx, profileId)).find((a) => a.resume_id === resume.id) ?? null) : null;

  const step = !resume ? 'resume' : !confirmed ? 'review' : 'complete';
  const draft = analysis && analysis.status === 'draft' ? analysis : null;
  const review = step === 'review' || (step === 'complete' && draft) ? buildReview(profile, confirmed, draft) : null;

  return {
    step,
    profile,
    resume,
    resume_count: count,
    cv: confirmed,
    analysis: analysis
      ? { id: analysis.id, status: analysis.status, model: analysis.model, analyzed_at: analysis.analyzed_at }
      : null,
    review,
  };
}

/** Add the confirmed review items to existing details without replacing any. */
export function merge(confirmed: CVData, additions: CVData): CVData {
  const merged: CVData = { ...confirmed };
  if (additions.summary) merged.summary = additions.summary;
  for (const section of [...LIST_SECTIONS, ...ENTRY_SECTIONS]) {
    const existing = confirmed[section] as unknown[];
    const fresh = newItems(section, additions[section] as unknown[], existing);
    (merged as unknown as Record<string, unknown>)[section] = [...existing, ...fresh];
  }
  return merged;
}

/**
 * Save the reviewed details: fill empty contact fields and add new CV items.
 * Already-confirmed values are never overwritten.
 */
export async function confirm(ctx: Ctx, profileId: string, body: ReviewSubmission): Promise<OnboardingState> {
  const profile = await getProfile(ctx, profileId);
  const submitted = isObject(body) ? body : ({} as ReviewSubmission);

  const fill: Partial<Record<ContactField, string>> = {};
  const contact = isObject(submitted.contact) ? submitted.contact : {};
  for (const field of CONTACT_FIELDS) {
    const value = contact[field];
    if (typeof value === 'string' && value.trim() && !profile[field]) fill[field] = value;
  }

  const details = await findDetails(ctx, profileId);
  const confirmed = details ? detailsToData(details) : EMPTY_CV;
  const merged = cleanCv(merge(confirmed, cleanCv(submitted.cv ?? {})));

  // Everything is checked before anything is written.
  if (Object.keys(fill).length) await updateProfile(ctx, profileId, fill);
  await saveDetails(ctx, profileId, { ...merged, source_analysis_id: submitted.source_analysis_id ?? null });
  return getState(ctx, profileId);
}
