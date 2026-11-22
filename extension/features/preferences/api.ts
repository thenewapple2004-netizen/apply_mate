import { apiRequest } from '../../lib/api.ts';

export type Arrangement = 'remote' | 'hybrid' | 'onsite';

export const ARRANGEMENTS: { value: Arrangement; label: string }[] = [
  { value: 'remote', label: 'Remote' },
  { value: 'hybrid', label: 'Hybrid' },
  { value: 'onsite', label: 'On-site' },
];

/** Every field is optional: empty / null means "not set". */
export interface Preferences {
  salary_expectation: string | null;
  notice_period: string | null;
  preferred_locations: string[];
  work_arrangements: Arrangement[];
  work_authorization_countries: string[];
  requires_sponsorship: boolean | null;
  change_reason: string | null;
}

export const EMPTY_PREFERENCES: Preferences = {
  salary_expectation: null,
  notice_period: null,
  preferred_locations: [],
  work_arrangements: [],
  work_authorization_countries: [],
  requires_sponsorship: null,
  change_reason: null,
};

const url = (profileId: string) => `/api/v1/profiles/${encodeURIComponent(profileId)}/preferences`;

/** Only the editable fields: the server rejects anything else (e.g. the `updated_at` it returns). */
function editable(p: Preferences): Preferences {
  return {
    salary_expectation: p.salary_expectation,
    notice_period: p.notice_period,
    preferred_locations: p.preferred_locations,
    work_arrangements: p.work_arrangements,
    work_authorization_countries: p.work_authorization_countries,
    requires_sponsorship: p.requires_sponsorship,
    change_reason: p.change_reason,
  };
}

export const preferencesApi = {
  get: async (profileId: string, signal?: AbortSignal) =>
    editable(await apiRequest<Preferences>(url(profileId), { signal })),
  save: async (profileId: string, preferences: Preferences) =>
    editable(await apiRequest<Preferences>(url(profileId), { method: 'PUT', body: editable(preferences) })),
};
