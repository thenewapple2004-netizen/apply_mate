/**
 * Remembered between popup openings (chrome.storage.local, this browser only).
 *
 * Everything is scoped so information can't leak between applicants or jobs:
 * - the confirmed job is stored per profile:              job:<profileId>
 * - prepared answers per profile, job and page:           prepared:<profileId>:<jobId>:<page>
 * Changing or clearing a job deletes its prepared answers; deleting a profile
 * deletes everything stored for it.
 */
import type { Job, PreparedAnswer } from './api.ts';
import type { DetectedField, Detection, FillStatus } from './page-scripts.ts';

const jobKey = (profileId: string) => `job:${profileId}`;
const preparedPrefix = (profileId: string, jobId?: string) =>
  jobId ? `prepared:${profileId}:${jobId}:` : `prepared:${profileId}:`;
/** The page, without query string or fragment (tracking parameters vary). */
export const pageKey = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
};
const MAX_AGE_MS = 14 * 24 * 3600 * 1000;

export interface ConfirmedJob extends Job {
  id: string;
  profileId: string;
  confirmedAt: string;
}

export interface PreparedPage {
  profileId: string;
  jobId: string;
  page: string;
  createdAt: string;
  fields: DetectedField[];
  unsupported: Detection['unsupported'];
  answers: PreparedAnswer[];
  aiError: string | null;
  /** How many answers were reused instantly (no AI call). */
  cacheHits?: number;
  /** The backend's context version when these answers were prepared. */
  contextVersion?: string;
  /** Result of the last fill, per field id. */
  fillStatus: Record<string, FillStatus> | null;
}

export async function loadJob(profileId: string): Promise<ConfirmedJob | null> {
  await removeLegacyData();
  const stored = (await browser.storage.local.get(jobKey(profileId)))[jobKey(profileId)] as ConfirmedJob | undefined;
  // Never use a job that belongs to someone else.
  return stored && stored.profileId === profileId ? stored : null;
}

export async function saveJob(profileId: string, job: Job, previous: ConfirmedJob | null): Promise<ConfirmedJob> {
  if (previous) await removeByPrefix(preparedPrefix(profileId, previous.id));
  const confirmed: ConfirmedJob = { ...job, id: crypto.randomUUID(), profileId, confirmedAt: new Date().toISOString() };
  await browser.storage.local.set({ [jobKey(profileId)]: confirmed });
  return confirmed;
}

export async function clearJob(profileId: string, job: ConfirmedJob | null): Promise<void> {
  if (job) await removeByPrefix(preparedPrefix(profileId, job.id));
  await browser.storage.local.remove(jobKey(profileId));
}

export async function loadPrepared(profileId: string, job: ConfirmedJob, url: string): Promise<PreparedPage | null> {
  const key = preparedPrefix(profileId, job.id) + pageKey(url);
  const stored = (await browser.storage.local.get(key))[key] as PreparedPage | undefined;
  if (!stored) return null;
  const fresh = Date.now() - Date.parse(stored.createdAt) < MAX_AGE_MS;
  if (stored.profileId !== profileId || stored.jobId !== job.id || stored.page !== pageKey(url) || !fresh) {
    await browser.storage.local.remove(key);
    return null;
  }
  return stored;
}

export async function savePrepared(page: PreparedPage): Promise<void> {
  await browser.storage.local.set({ [preparedPrefix(page.profileId, page.jobId) + page.page]: page });
}

export async function clearPrepared(page: Pick<PreparedPage, 'profileId' | 'jobId' | 'page'>): Promise<void> {
  await browser.storage.local.remove(preparedPrefix(page.profileId, page.jobId) + page.page);
}

/** Discards every prepared answer for a profile (its job is kept). Used when something the
 *  answers were based on changes, such as the profile's preferences. */
export async function forgetPrepared(profileId: string): Promise<void> {
  await removeByPrefix(preparedPrefix(profileId));
}

/** Removes everything stored for a profile (called when the profile is deleted). */
export async function forgetProfile(profileId: string): Promise<void> {
  await removeByPrefix(preparedPrefix(profileId));
  await browser.storage.local.remove(jobKey(profileId));
}

async function removeByPrefix(prefix: string): Promise<void> {
  const all = await browser.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(prefix));
  if (keys.length) await browser.storage.local.remove(keys);
}

/** Data from the earlier version wasn't scoped per profile/job: drop it rather than guess. */
async function removeLegacyData(): Promise<void> {
  const all = await browser.storage.local.get(null);
  const legacy = Object.keys(all).filter(
    (k) => k === 'confirmedJob' || (k.startsWith('prepared:') && !(all[k] as PreparedPage)?.jobId),
  );
  if (legacy.length) await browser.storage.local.remove(legacy);
}
