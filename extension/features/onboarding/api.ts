import { apiRequest } from '../../lib/api.ts';
import type { CVData } from '../cv/api.ts';
import type { Profile } from '../profiles/api.ts';
import type { Resume } from '../resumes/api.ts';

export type ContactField = 'email' | 'phone' | 'location' | 'linkedin_url';
export type Section = keyof CVData;

export const CONTACT_LABELS: Record<ContactField, string> = {
  email: 'Email',
  phone: 'Phone',
  location: 'Location',
  linkedin_url: 'LinkedIn URL',
};

export interface ReviewForm {
  /** Profile fields that are still empty; `contact` holds AI suggestions for them. */
  contact_fields: ContactField[];
  contact: Partial<Record<ContactField, string | null>>;
  /** CV sections to show; `cv` holds only items that aren't confirmed yet. */
  sections: Section[];
  cv: CVData;
  source_analysis_id: string | null;
  warnings: string[];
}

export interface OnboardingState {
  step: 'resume' | 'review' | 'complete';
  profile: Profile;
  resume: Resume | null;
  resume_count: number;
  cv: CVData | null;
  analysis: { id: string; status: 'draft' | 'confirmed'; model: string; analyzed_at: string } | null;
  review: ReviewForm | null;
}

export interface ReviewSubmission {
  contact: Partial<Record<ContactField, string>>;
  cv: CVData;
  source_analysis_id: string | null;
}

const base = (profileId: string) => `/api/v1/profiles/${encodeURIComponent(profileId)}/onboarding`;

export const onboardingApi = {
  get: (profileId: string, signal?: AbortSignal) =>
    apiRequest<OnboardingState>(base(profileId), { signal }),

  confirm: (profileId: string, body: ReviewSubmission) =>
    apiRequest<OnboardingState>(`${base(profileId)}/confirm`, { method: 'POST', body }),
};
