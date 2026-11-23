/**
 * Preparing answers runs in the extension's background service worker, so closing the popup
 * (or switching tabs) doesn't stop it. The result is saved in storage; the popup picks it up
 * when it is open, or the next time it opens.
 */
import type { Ctx } from '../../core/ctx.ts';
import { makeAi } from '../../core/settings.ts';
import { ChromeStore } from '../../lib/chrome-store.ts';
import { prepare } from '../../core/prepare.ts';

import type { Job } from './api.ts';
import type { DetectedField, Detection } from './page-scripts.ts';
import { type PreparedPage, savePrepared } from './storage.ts';

export const PREPARE_MESSAGE = 'jf-prepare';
export const STALE_RUN_MS = 4 * 60 * 1000;

export interface PrepareRequest {
  type: typeof PREPARE_MESSAGE;
  profileId: string;
  jobId: string;
  page: string;
  job: Job;
  fields: DetectedField[];
  unsupported: Detection['unsupported'];
  refresh: boolean;
}

/** What the background is doing for a profile; the popup watches it. */
export interface PrepareRun {
  state: 'running' | 'done' | 'error';
  jobId: string;
  page: string;
  startedAt: string;
  error?: string;
}

export const runKey = (profileId: string): string => `jf-run:${profileId}`;

const isRequest = (m: unknown): m is PrepareRequest => typeof m === 'object' && m !== null && (m as { type?: unknown }).type === PREPARE_MESSAGE;

export function startBackground(): void {
  const store = new ChromeStore();
  // The popup's PDF reader isn't needed here: preparing answers only uses storage and the AI.
  const ctx: Ctx = { store, ai: makeAi(store), pdf: async () => { throw new Error('not available here'); } };

  browser.runtime.onMessage.addListener((message: unknown) => {
    if (!isRequest(message)) return undefined;
    void run(ctx, message); // not awaited: the popup may close at any moment
    return Promise.resolve({ started: true });
  });
}

async function run(ctx: Ctx, req: PrepareRequest): Promise<void> {
  const base = { jobId: req.jobId, page: req.page, startedAt: new Date().toISOString() };
  await ctx.store.set(runKey(req.profileId), { ...base, state: 'running' } satisfies PrepareRun);
  // A service worker is stopped when idle; calling an extension API now and then keeps it alive.
  const keepAlive = setInterval(() => void browser.runtime.getPlatformInfo(), 20_000);
  try {
    const result = await prepare(ctx, req.profileId, {
      job: req.job,
      refresh: req.refresh,
      fields: req.fields.map(({ id, label, type, required, options }) => ({ id, label, type, required, options })),
    });
    const prepared: PreparedPage = {
      profileId: req.profileId,
      jobId: req.jobId,
      page: req.page,
      createdAt: new Date().toISOString(),
      fields: req.fields,
      unsupported: req.unsupported,
      answers: result.answers,
      aiError: result.ai_error,
      cacheHits: result.cache_hits,
      contextVersion: result.context_version,
      fillStatus: null,
    };
    await savePrepared(prepared);
    await ctx.store.set(runKey(req.profileId), { ...base, state: 'done' } satisfies PrepareRun);
  } catch (error) {
    const text = error instanceof Error ? error.message : 'Something went wrong.';
    await ctx.store.set(runKey(req.profileId), { ...base, state: 'error', error: text } satisfies PrepareRun);
  } finally {
    clearInterval(keepAlive);
  }
}
