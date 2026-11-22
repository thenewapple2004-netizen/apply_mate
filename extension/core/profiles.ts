import type { Ctx } from './ctx.ts';
import { invalid, notFound } from './errors.ts';
import { PROFILES_KEY } from './store.ts';
import { nowIso, uuid } from './text.ts';
import type { Profile, ProfileInput } from './types.ts';
import { checkEmail, checkLinkedin, checkPhone, type Errors, optionalText } from './validation.ts';

const FIELDS = ['full_name', 'email', 'phone', 'location', 'linkedin_url'] as const;

function validate(input: Partial<ProfileInput>, requireName: boolean): { values: Partial<ProfileInput>; errors: Errors } {
  const errors: Errors = {};
  const values: Partial<ProfileInput> = {};
  if (requireName || 'full_name' in input) {
    const name = optionalText(errors, 'full_name', input.full_name, 200);
    if (name === null && !errors.full_name) errors.full_name = requireName ? 'Full name is required' : "can't be removed";
    values.full_name = name ?? '';
  }
  if ('email' in input) values.email = optionalText(errors, 'email', input.email, 320, checkEmail);
  if ('phone' in input) values.phone = optionalText(errors, 'phone', input.phone, 40, checkPhone);
  if ('location' in input) values.location = optionalText(errors, 'location', input.location, 200);
  if ('linkedin_url' in input) values.linkedin_url = optionalText(errors, 'linkedin_url', input.linkedin_url, 500, checkLinkedin);
  for (const key of Object.keys(input)) {
    if (!(FIELDS as readonly string[]).includes(key)) errors[key] = 'is not allowed';
  }
  return { values, errors };
}

function fail(errors: Errors): never {
  throw invalid(Object.values(errors)[0] ?? 'Please correct the highlighted fields', errors);
}

export async function listProfiles(ctx: Ctx): Promise<Profile[]> {
  return (await ctx.store.get<Profile[]>(PROFILES_KEY)) ?? [];
}

export async function getProfile(ctx: Ctx, id: string): Promise<Profile> {
  const profile = (await listProfiles(ctx)).find((p) => p.id === id);
  if (!profile) throw notFound('Profile');
  return profile;
}

export const requireProfile = getProfile;

export async function createProfile(ctx: Ctx, input: ProfileInput): Promise<Profile> {
  const { values, errors } = validate(input, true);
  if (Object.keys(errors).length) fail(errors);
  const now = nowIso();
  const profile: Profile = {
    id: uuid(),
    full_name: values.full_name ?? '',
    email: values.email ?? null,
    phone: values.phone ?? null,
    location: values.location ?? null,
    linkedin_url: values.linkedin_url ?? null,
    created_at: now,
    updated_at: now,
  };
  await ctx.store.update<Profile[]>(PROFILES_KEY, (all) => [...(all ?? []), profile]);
  return profile;
}

/** Only the fields sent are changed. */
export async function updateProfile(ctx: Ctx, id: string, changes: Partial<ProfileInput>): Promise<Profile> {
  await getProfile(ctx, id);
  const { values, errors } = validate(changes, false);
  if (Object.keys(errors).length) fail(errors);
  let updated: Profile | undefined;
  await ctx.store.update<Profile[]>(PROFILES_KEY, (all) =>
    (all ?? []).map((p) => {
      if (p.id !== id) return p;
      updated = { ...p, ...values, updated_at: nowIso() } as Profile;
      return updated;
    }),
  );
  if (!updated) throw notFound('Profile');
  return updated;
}

/** Deletes the profile and everything stored for it. */
export async function deleteProfile(ctx: Ctx, id: string): Promise<void> {
  await getProfile(ctx, id);
  await ctx.store.update<Profile[]>(PROFILES_KEY, (all) => (all ?? []).filter((p) => p.id !== id));
  await ctx.store.remove(await ctx.store.keys(`jf:p:${id}:`));
}
