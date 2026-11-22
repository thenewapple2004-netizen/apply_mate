import { confirm, getState } from '../../core/onboarding.ts';
import { ctx } from '@/lib/runtime.ts';

export type { ContactField, OnboardingState, ReviewForm, ReviewSubmission, Section } from '../../core/types.ts';
import type { ContactField, OnboardingState, ReviewSubmission } from '../../core/types.ts';

export const CONTACT_LABELS: Record<ContactField, string> = {
  email: 'Email',
  phone: 'Phone',
  location: 'Location',
  linkedin_url: 'LinkedIn URL',
};

export const onboardingApi = {
  get: (profileId: string, _signal?: AbortSignal): Promise<OnboardingState> => getState(ctx, profileId),

  confirm: (profileId: string, body: ReviewSubmission): Promise<OnboardingState> => confirm(ctx, profileId, body),
};
