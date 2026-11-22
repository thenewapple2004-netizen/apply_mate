/**
 * Which approved answers may be remembered for future applications.
 * The backend applies the same rules (app/modules/answers/service.py).
 */
import type { PreparedAnswer } from './api.ts';
import type { DetectedField, FillStatus } from './page-scripts.ts';

/** Agreements the applicant must make personally, every time. */
export const CONSENT = /\b(agree|consent|certify|acknowledge|accept|terms|privacy|policy|declare|attest)\b/i;
/** Personal/demographic or negotiable answers: never stored for reuse. */
export const SENSITIVE =
  /\b(gender|sex|race|racial|ethnic\w*|hispanic|latin[oax]|veteran|disabilit\w*|sexual orientation|pronouns?|age range|date of birth|religio\w*|marital|criminal|conviction|salary|compensation|pay expectations?)\b/i;
/** Answers written for one particular job/company. */
const JOB_SPECIFIC =
  /\b(why|cover letter|motivation|interest(ed)? in|about yourself|anything else|additional information|how did you hear|referr(ed|al))\b/i;

export function shouldRemember(field: DetectedField, answer: PreparedAnswer, status: FillStatus | undefined): boolean {
  const answered = (answer.value?.trim() ?? '') !== '' || answer.values.length > 0;
  return (
    answered &&
    (status === 'filled' || status === 'unchanged') && // verified on the page
    answer.source !== 'profile' && // already in the profile
    answer.source !== 'none' &&
    Boolean(field.label) &&
    !CONSENT.test(field.label) &&
    !SENSITIVE.test(field.label) &&
    !JOB_SPECIFIC.test(field.label)
  );
}
