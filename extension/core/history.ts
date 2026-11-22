/** Applied-jobs history and statistics (per profile). */
import type { Ctx } from './ctx.ts';
import { invalid, notFound } from './errors.ts';
import { requireProfile } from './profiles.ts';
import { profileKey } from './store.ts';
import { collapse, nowIso, sha256Hex, uuid } from './text.ts';
import type { ApplicationStats, JobApplication, StoredApplication } from './types.ts';

// Query parameters that identify a visit, not a job: ignored when comparing links.
const TRACKING = /^(utm_.*|gh_src|src|source|ref|referrer|fbclid|gclid|lever-.*|trk|mc_.*|_hs.*)$/i;
const key = (profileId: string): string => profileKey(profileId, 'apps');

/**
 * Identifies a job: its link without tracking parameters (and without a trailing /apply, so the
 * posting and its form match), or title and company if there is no link.
 */
export async function jobKey(title: string, company: string, url: string): Promise<string> {
  let normalized = `${company.trim().toLowerCase()}|${title.trim().toLowerCase()}`;
  try {
    const parsed = new URL(url.trim());
    if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host) {
      const path = parsed.pathname.replace(/\/+$/, '').replace(/\/apply$/i, '').toLowerCase();
      const query = [...parsed.searchParams.entries()]
        .filter(([k]) => !TRACKING.test(k))
        .map(([k, v]) => [k.toLowerCase(), v] as const)
        .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
      normalized = `${parsed.host.toLowerCase()}${path}?${new URLSearchParams(query as unknown as string[][]).toString()}`;
    }
  } catch {
    // not a link: title and company are used
  }
  return sha256Hex(normalized);
}

const toApplication = (a: StoredApplication, already: boolean): JobApplication => ({
  id: a.id,
  title: a.title,
  company: a.company,
  url: a.url,
  applied_at: a.applied_at,
  already_recorded: already,
});

export interface ApplicationInput {
  title?: string;
  company?: string;
  url?: string;
  /** For entering past applications; defaults to now. Must include a timezone. */
  applied_at?: string | null;
}

/** Save an application. An already-recorded job isn't counted twice. */
export async function recordApplication(ctx: Ctx, profileId: string, input: ApplicationInput): Promise<JobApplication> {
  await requireProfile(ctx, profileId);
  const title = collapse(input.title ?? '').slice(0, 300);
  const company = collapse(input.company ?? '').slice(0, 300);
  const url = collapse(input.url ?? '').slice(0, 2000);
  if (!title && !url) throw invalid('a job title or link is required');
  let appliedAt = nowIso();
  if (input.applied_at) {
    const t = Date.parse(input.applied_at);
    if (Number.isNaN(t) || !/(Z|[+-]\d\d:?\d\d)$/i.test(input.applied_at)) throw invalid('applied_at must include a time zone');
    if (t > Date.now() + 5 * 60_000) throw invalid("applied_at can't be in the future");
    appliedAt = new Date(t).toISOString();
  }
  const jk = await jobKey(title, company, url);
  let result: JobApplication | undefined;
  await ctx.store.update<StoredApplication[]>(key(profileId), (all) => {
    const rows = all ?? [];
    const existing = rows.find((r) => r.job_key === jk);
    if (existing) {
      result = toApplication(existing, true);
      return rows;
    }
    const row: StoredApplication = { id: uuid(), job_key: jk, title, company, url, applied_at: appliedAt };
    result = toApplication(row, false);
    return [...rows, row];
  });
  return result as JobApplication;
}

/** Most recent applications first. */
export async function listApplications(ctx: Ctx, profileId: string, limit = 20): Promise<JobApplication[]> {
  await requireProfile(ctx, profileId);
  const rows = (await ctx.store.get<StoredApplication[]>(key(profileId))) ?? [];
  return [...rows]
    .sort((a, b) => b.applied_at.localeCompare(a.applied_at) || a.id.localeCompare(b.id))
    .slice(0, Math.min(Math.max(limit, 1), 100))
    .map((r) => toApplication(r, false));
}

export async function removeApplication(ctx: Ctx, profileId: string, applicationId: string): Promise<void> {
  await requireProfile(ctx, profileId);
  let found = false;
  await ctx.store.update<StoredApplication[]>(key(profileId), (all) =>
    (all ?? []).filter((r) => {
      if (r.id === applicationId) found = true;
      return r.id !== applicationId;
    }),
  );
  if (!found) throw notFound('Application');
}

/** The instant a calendar day (in `timeZone`) starts, for the day `daysAgo` days before today. */
function dayStart(now: number, timeZone: string, daysAgo: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(now));
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value);
  const localAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  const offset = localAsUtc - Math.floor(now / 1000) * 1000;
  return Date.UTC(get('year'), get('month') - 1, get('day') - daysAgo) - offset;
}

/** Counts for the applicant's own calendar: "today" starts at their local midnight. */
export async function applicationStats(ctx: Ctx, profileId: string, timeZone = 'UTC', now = Date.now()): Promise<ApplicationStats> {
  await requireProfile(ctx, profileId);
  let midnight: number, weekStart: number, monthStart: number;
  try {
    midnight = dayStart(now, timeZone, 0);
    weekStart = dayStart(now, timeZone, 6); // today and the six days before it
    monthStart = dayStart(now, timeZone, 29);
  } catch {
    throw invalid('Unknown time zone');
  }
  const rows = (await ctx.store.get<StoredApplication[]>(key(profileId))) ?? [];
  const at = (r: StoredApplication): number => Date.parse(r.applied_at);
  return {
    total: rows.length,
    today: rows.filter((r) => at(r) >= midnight).length,
    last_7_days: rows.filter((r) => at(r) >= weekStart).length,
    last_30_days: rows.filter((r) => at(r) >= monthStart).length,
  };
}
