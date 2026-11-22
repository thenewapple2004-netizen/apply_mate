import { apiRequest } from '@/lib/api.ts';

export interface Profile {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  location: string | null;
  linkedin_url: string | null;
  created_at: string;
  updated_at: string;
}

/** The editable fields. Empty strings are stored as null by the backend. */
export type ProfileInput = Pick<
  Profile,
  'full_name' | 'email' | 'phone' | 'location' | 'linkedin_url'
>;

const BASE = '/api/v1/profiles';

export const profilesApi = {
  list: (signal?: AbortSignal) => apiRequest<Profile[]>(BASE, { signal }),

  create: (input: ProfileInput) => apiRequest<Profile>(BASE, { method: 'POST', body: input }),

  update: (id: string, changes: Partial<ProfileInput>) =>
    apiRequest<Profile>(`${BASE}/${encodeURIComponent(id)}`, { method: 'PATCH', body: changes }),

  remove: (id: string) =>
    apiRequest<void>(`${BASE}/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};
