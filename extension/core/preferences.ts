import type { Ctx } from './ctx.ts';
import { invalid } from './errors.ts';
import { requireProfile } from './profiles.ts';
import { profileKey } from './store.ts';
import { nowIso } from './text.ts';
import type { Arrangement, Preferences, StoredPreferences } from './types.ts';
import { EMPTY_PREFERENCES } from './types.ts';
import { type Errors, isObject, optionalText, rejectUnknown, textList } from './validation.ts';

const ARRANGEMENTS: readonly Arrangement[] = ['remote', 'hybrid', 'onsite'];
const KEYS = [
  'salary_expectation', 'notice_period', 'preferred_locations', 'work_arrangements',
  'work_authorization_countries', 'requires_sponsorship', 'change_reason', 'career_goals',
] as const;

const key = (profileId: string): string => profileKey(profileId, 'prefs');

/** Validate and clean preferences. Every field is optional; empty means "not set". */
export function cleanPreferences(input: unknown): Preferences {
  const errors: Errors = {};
  const src: Record<string, unknown> = isObject(input) ? input : {};
  rejectUnknown(errors, src, KEYS);

  const arrangements: Arrangement[] = [];
  if (src.work_arrangements !== undefined && src.work_arrangements !== null) {
    if (!Array.isArray(src.work_arrangements)) errors.work_arrangements = 'must be a list';
    else {
      for (const item of src.work_arrangements) {
        if (!ARRANGEMENTS.includes(item as Arrangement)) errors.work_arrangements = 'must be remote, hybrid or onsite';
        else if (!arrangements.includes(item as Arrangement)) arrangements.push(item as Arrangement);
      }
    }
  }
  if (src.requires_sponsorship !== undefined && src.requires_sponsorship !== null && typeof src.requires_sponsorship !== 'boolean') {
    errors.requires_sponsorship = 'must be true, false or empty';
  }

  const prefs: Preferences = {
    salary_expectation: optionalText(errors, 'salary_expectation', src.salary_expectation, 200),
    notice_period: optionalText(errors, 'notice_period', src.notice_period, 100),
    preferred_locations: textList(errors, 'preferred_locations', src.preferred_locations, 30, 100),
    work_arrangements: arrangements,
    work_authorization_countries: textList(errors, 'work_authorization_countries', src.work_authorization_countries, 30, 100),
    requires_sponsorship: typeof src.requires_sponsorship === 'boolean' ? src.requires_sponsorship : null,
    change_reason: optionalText(errors, 'change_reason', src.change_reason, 2000),
    career_goals: optionalText(errors, 'career_goals', src.career_goals, 2000),
  };
  if (Object.keys(errors).length) throw invalid(Object.values(errors)[0] ?? 'Invalid preferences', errors);
  return prefs;
}

export async function getStoredPreferences(ctx: Ctx, profileId: string): Promise<StoredPreferences | undefined> {
  return ctx.store.get<StoredPreferences>(key(profileId));
}

/** The profile's preferences (all empty until saved). */
export async function getPreferences(ctx: Ctx, profileId: string): Promise<Preferences & { updated_at: string | null }> {
  await requireProfile(ctx, profileId);
  const stored = await getStoredPreferences(ctx, profileId);
  return stored ?? { ...EMPTY_PREFERENCES, updated_at: null };
}

/** Replaces everything: omitted or empty fields become "not set". */
export async function savePreferences(ctx: Ctx, profileId: string, input: unknown): Promise<StoredPreferences> {
  await requireProfile(ctx, profileId);
  const stored: StoredPreferences = { ...cleanPreferences(input), updated_at: nowIso() };
  await ctx.store.set(key(profileId), stored);
  return stored;
}
