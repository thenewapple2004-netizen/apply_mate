import { createProfile, deleteProfile, listProfiles, updateProfile } from '../../core/profiles.ts';
import { ctx } from '@/lib/runtime.ts';

export type { Profile, ProfileInput } from '../../core/types.ts';
import type { Profile, ProfileInput } from '../../core/types.ts';

/** Profiles live in this browser (chrome.storage.local). Empty strings are stored as null. */
export const profilesApi = {
  list: (_signal?: AbortSignal): Promise<Profile[]> => listProfiles(ctx),

  create: (input: ProfileInput): Promise<Profile> => createProfile(ctx, input),

  update: (id: string, changes: Partial<ProfileInput>): Promise<Profile> => updateProfile(ctx, id, changes),

  remove: (id: string): Promise<void> => deleteProfile(ctx, id),
};
