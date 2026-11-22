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
}

export interface PrepareResponse {
  answers: PreparedAnswer[];
  ai_used: boolean;
  ai_error: string | null;
}

const base = (profileId: string) => `/api/v1/profiles/${encodeURIComponent(profileId)}`;

export const applyApi = {
  prepare: (profileId: string, job: Job, fields: DetectedField[]) =>
    apiRequest<PrepareResponse>(`${base(profileId)}/applications/answers`, {
      method: 'POST',
      body: { job, fields },
      timeoutMs: 180_000, // the AI can take a while on long forms
    }),

  saveAnswers: (profileId: string, answers: { question: string; answer: string }[]) =>
    apiRequest<{ saved: number }>(`${base(profileId)}/answers`, { method: 'PUT', body: { answers } }),
};
