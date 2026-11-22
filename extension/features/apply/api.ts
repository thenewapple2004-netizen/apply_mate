import { apiRequest } from '../../lib/api.ts';

import type { DetectedField } from './page-scripts.ts';

export interface Job {
  title: string;
  company: string;
  description: string;
  url: string;
}

export interface PreparedAnswer {
  field_id: string;
  value: string | null;
  values: string[];
  /** Where the answer came from; 'user' once you edit it in the review. */
  source: 'profile' | 'cv' | 'saved' | 'ai' | 'user' | 'none';
  note: string | null;
  /** Choices to click for an unanswered text question (e.g. "Yes" / "No"), each with
   *  the answer to use when picked (null: worded by the backend on click). */
  suggestions?: { label: string; answer: string | null }[];
  /** Reused from an earlier identical question: no AI call was needed. */
  cached?: boolean;
}

export interface PrepareResponse {
  answers: PreparedAnswer[];
  ai_used: boolean;
  ai_error: string | null;
  cache_hits: number;
}

const base = (profileId: string) => `/api/v1/profiles/${encodeURIComponent(profileId)}`;

export const applyApi = {
  prepare: (profileId: string, job: Job, fields: DetectedField[], refresh = false) =>
    apiRequest<PrepareResponse>(`${base(profileId)}/applications/answers`, {
      method: 'POST',
      // Only the question itself; how to find it on the page stays in the extension.
      body: {
        job,
        refresh, // true: ignore remembered answers and ask the AI again
        fields: fields.map(({ id, label, type, required, options }) => ({ id, label, type, required, options })),
      },
      timeoutMs: 180_000, // the AI can take a while on long forms
    }),

  /** Writes a short answer from the choice the user clicked, keeping that choice. */
  compose: (profileId: string, job: Job, question: string, type: string, choice: string) =>
    apiRequest<{ value: string; composed: boolean }>(`${base(profileId)}/applications/answers/compose`, {
      method: 'POST',
      body: { job, question, type, choice },
      timeoutMs: 120_000, // includes the backend's retry if Gemini is briefly unavailable
    }),

  saveAnswers: (profileId: string, answers: { question: string; answer: string }[]) =>
    apiRequest<{ saved: number }>(`${base(profileId)}/answers`, { method: 'PUT', body: { answers } }),
};
