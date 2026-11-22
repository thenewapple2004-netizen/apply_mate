import { saveAnswers } from '../../core/answers.ts';
import { applicationStats, listApplications, recordApplication, removeApplication } from '../../core/history.ts';
import { compose, currentContextVersion, prepare } from '../../core/prepare.ts';
import { ctx } from '@/lib/runtime.ts';

import type { DetectedField } from './page-scripts.ts';

export type {
  ApplicationStats, JobApplication, JobInfo as Job, PrepareResponse, PreparedAnswer,
} from '../../core/types.ts';
import type { ApplicationStats, JobApplication, JobInfo as Job, PrepareResponse } from '../../core/types.ts';

export const applyApi = {
  prepare: (profileId: string, job: Job, fields: DetectedField[], refresh = false): Promise<PrepareResponse> =>
    prepare(ctx, profileId, {
      job,
      refresh, // true: ignore remembered answers and ask the AI again
      // Only the question itself; how to find it on the page stays in the extension.
      fields: fields.map(({ id, label, type, required, options }) => ({ id, label, type, required, options })),
    }),

  /** The current version of everything answers are based on. Answers prepared under an
   *  older version are out of date. */
  contextVersion: async (profileId: string, _signal?: AbortSignal): Promise<{ version: string }> => ({
    version: await currentContextVersion(ctx, profileId),
  }),

  /** Records that the user submitted this job. Safe to repeat: the same job counts once. */
  markApplied: (profileId: string, job: Pick<Job, 'title' | 'company' | 'url'>): Promise<JobApplication> =>
    recordApplication(ctx, profileId, { title: job.title, company: job.company, url: job.url }),

  listApplications: (profileId: string, _signal?: AbortSignal): Promise<JobApplication[]> =>
    listApplications(ctx, profileId, 10),

  /** "Today" and "last 7 days" are counted in the user's own time zone. */
  applicationStats: (profileId: string, _signal?: AbortSignal): Promise<ApplicationStats> =>
    applicationStats(ctx, profileId, Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'),

  removeApplication: (profileId: string, applicationId: string): Promise<void> =>
    removeApplication(ctx, profileId, applicationId),

  /** Writes a short answer from the choice the user clicked, keeping that choice. */
  compose: (profileId: string, job: Job, question: string, type: string, choice: string) =>
    compose(ctx, profileId, { job, question, type: type as never, choice }),

  saveAnswers: async (profileId: string, answers: { question: string; answer: string }[]) => ({
    saved: await saveAnswers(ctx, profileId, answers),
  }),
};
