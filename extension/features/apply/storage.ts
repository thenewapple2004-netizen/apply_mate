/**
 * Remembered between popup openings (chrome.storage.local, this browser only):
 * - the confirmed job, so it carries over from the posting to the application form
 * - prepared answers per page, so closing the popup to look at the page loses nothing
 */
import type { Job, PreparedAnswer } from './api.ts';
import type { DetectedField } from './page-scripts.ts';

const JOB_KEY = 'confirmedJob';
const answersKey = (profileId: string, url: string) => `prepared:${profileId}:${url.split('#')[0]}`;

export interface ConfirmedJob extends Job {
  confirmedAt: string;
}

export interface PreparedPage {
  fields: DetectedField[];
  answers: PreparedAnswer[];
  aiError: string | null;
  filled: boolean;
}

export async function loadJob(): Promise<ConfirmedJob | null> {
  const stored = await browser.storage.local.get(JOB_KEY);
  return (stored[JOB_KEY] as ConfirmedJob | undefined) ?? null;
}

export async function saveJob(job: Job): Promise<ConfirmedJob> {
  const confirmed = { ...job, confirmedAt: new Date().toISOString() };
  await browser.storage.local.set({ [JOB_KEY]: confirmed });
  return confirmed;
}

export async function clearJob(): Promise<void> {
  await browser.storage.local.remove(JOB_KEY);
}

export async function loadPrepared(profileId: string, url: string): Promise<PreparedPage | null> {
  const key = answersKey(profileId, url);
  const stored = await browser.storage.local.get(key);
  return (stored[key] as PreparedPage | undefined) ?? null;
}

export async function savePrepared(profileId: string, url: string, page: PreparedPage): Promise<void> {
  await browser.storage.local.set({ [answersKey(profileId, url)]: page });
}

export async function clearPrepared(profileId: string, url: string): Promise<void> {
  await browser.storage.local.remove(answersKey(profileId, url));
}
