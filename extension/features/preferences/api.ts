import { getPreferences, savePreferences } from '../../core/preferences.ts';
import { ctx } from '@/lib/runtime.ts';

export type { Arrangement, Preferences } from '../../core/types.ts';
export { EMPTY_PREFERENCES } from '../../core/types.ts';
import type { Arrangement, Preferences } from '../../core/types.ts';

export const ARRANGEMENTS: { value: Arrangement; label: string }[] = [
  { value: 'remote', label: 'Remote' },
  { value: 'hybrid', label: 'Hybrid' },
  { value: 'onsite', label: 'On-site' },
];

/** Only the editable fields (the saved record also has an `updated_at`). */
function editable(p: Preferences): Preferences {
  return {
    salary_expectation: p.salary_expectation,
    notice_period: p.notice_period,
    preferred_locations: p.preferred_locations,
    work_arrangements: p.work_arrangements,
    work_authorization_countries: p.work_authorization_countries,
    requires_sponsorship: p.requires_sponsorship,
    change_reason: p.change_reason,
    career_goals: p.career_goals,
  };
}

export const preferencesApi = {
  get: async (profileId: string, _signal?: AbortSignal): Promise<Preferences> =>
    editable(await getPreferences(ctx, profileId)),
  save: async (profileId: string, preferences: Preferences): Promise<Preferences> =>
    editable(await savePreferences(ctx, profileId, editable(preferences))),
};
