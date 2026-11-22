/**
 * Answers taken straight from the applicant's saved preferences (never from the AI).
 *
 * Salary, work authorization and sponsorship answers are only *proposed* (`needs_approval`):
 * the extension fills them after the user approves each one. When a preference isn't set,
 * nothing is invented: the question is left for the user with a note saying where to add it.
 */
import { answer as makeAnswer, matchOption } from './answers.ts';
import { norm } from './text.ts';
import type { FormField, PreparedAnswer, StoredPreferences } from './types.ts';

export type PrefKind =
  | 'salary' | 'notice' | 'locations' | 'arrangement' | 'authorization' | 'sponsorship' | 'change_reason' | 'career_goals';

/** Answers that need the user's explicit approval before they are filled. */
export const APPROVAL_KINDS: readonly PrefKind[] = ['salary', 'authorization', 'sponsorship'];

const SALARY = /\b(salary|salaries|compensation|remuneration|pay (expectations?|range|requirements?)|expected (pay|ctc|earnings?)|ctc)\b/;
const NOTICE = /\b(notice( period)?|how soon (can|could) you (start|join)|when (can|could) you (start|join)|earliest (start|joining)|availability to (start|join)|start date)\b/;
const CHANGE = /\b(reason|why)\b.*\b(leav\w*|chang\w*|looking|seeking|switch\w*|mov\w*)\b/;
const GOALS = /\b(career (goals?|aspirations?|objectives?|plans?)|long term (goals?|plans?)|where do you see yourself)\b/;
const LOCATIONS = /\b((preferred|desired|ideal) (work )?(locations?|cit(y|ies))|locations? preferences?|where (would|do) you (like|want|prefer) to work)\b/;
const ARRANGEMENT = /\b(work(ing)? (arrangement|model|mode|setup|style|preference|type)|remote(ly)?|hybrid|on ?site|in ?office|office based)\b/;
const AUTH = /\b(authori[sz]ed|authori[sz]ation|legally (able|eligible|entitled|permitted)|right to work|eligible to work|work permit|work eligibility)\b/;
const SPONSOR = /\b(sponsor\w*|visa)\b/;
const INVERTED = /\b(without|not (re)?quire|do not (need|require)|don t (need|require)|no need|not need)\b/;

const ARRANGEMENT_WORDS: Record<string, string[]> = { remote: ['remote'], hybrid: ['hybrid'], onsite: ['on site', 'onsite', 'in office', 'office'] };
const ARRANGEMENT_NAMES: Record<string, string> = { remote: 'Remote', hybrid: 'Hybrid', onsite: 'On-site' };

export const MISSING: Record<PrefKind, string> = {
  salary: "Your salary expectation isn't in your Preferences yet. Add it there, or answer here.",
  notice: "Your notice period isn't in your Preferences yet. Add it there, or answer here.",
  locations: "Your preferred locations aren't in your Preferences yet. Add them there, or answer here.",
  arrangement: "Your work arrangement preference isn't in your Preferences yet. Add it there, or answer here.",
  authorization: "Where you're authorized to work isn't in your Preferences yet. Add it there, or answer here.",
  sponsorship: "Your sponsorship needs aren't in your Preferences yet. Add them there, or answer here.",
  change_reason: "Your reason for changing jobs isn't in your Preferences yet. Add it there, or answer here.",
  career_goals: "Your career goals aren't in your Preferences yet. Add them there, or answer here.",
};

/** Which preference a question asks about, if it clearly asks about one. */
export function prefKind(field: FormField): PrefKind | null {
  if (field.type === 'checkbox' && field.options.length === 1) return null; // an agreement or declaration
  const label = norm(field.label);
  const auth = AUTH.test(label);
  const sponsor = SPONSOR.test(label);
  if (auth && sponsor) return 'authorization'; // compound: handled as "answer it yourself"
  if (sponsor) return 'sponsorship';
  if (auth) return 'authorization';
  if (SALARY.test(label)) return 'salary';
  if (CHANGE.test(label)) return 'change_reason';
  if (GOALS.test(label)) return 'career_goals';
  if (NOTICE.test(label)) return 'notice';
  if (LOCATIONS.test(label)) return 'locations';
  if (ARRANGEMENT.test(label) && !label.includes('relocat')) return 'arrangement';
  return null;
}

export function isMissing(prefs: StoredPreferences | undefined | null, which: PrefKind): boolean {
  if (!prefs) return true;
  switch (which) {
    case 'salary': return !prefs.salary_expectation;
    case 'notice': return !prefs.notice_period;
    case 'locations': return prefs.preferred_locations.length === 0;
    case 'arrangement': return prefs.work_arrangements.length === 0;
    case 'authorization': return prefs.work_authorization_countries.length === 0;
    case 'sponsorship': return prefs.requires_sponsorship === null;
    case 'change_reason': return !prefs.change_reason;
    case 'career_goals': return !prefs.career_goals;
  }
}

export const missingAnswer = (field: FormField, which: PrefKind): PreparedAnswer =>
  makeAnswer(field.id, { source: 'none', note: MISSING[which], preference: which });

type Make = (value?: string | null, values?: string[], note?: string | null) => PreparedAnswer;

/** The answer to a preference question, or a note saying why there isn't one. */
export function prefAnswer(field: FormField, which: PrefKind, prefs: StoredPreferences | undefined | null): PreparedAnswer {
  if (!prefs || isMissing(prefs, which)) return missingAnswer(field, which);
  const approval = APPROVAL_KINDS.includes(which);
  const make: Make = (value = null, values = [], note = null) => {
    const has = Boolean(value) || values.length > 0;
    return makeAnswer(field.id, {
      value: value || null,
      values,
      source: has ? 'preference' : 'none',
      note: has ? null : note,
      needs_approval: approval && has,
      preference: which,
    });
  };

  switch (which) {
    case 'salary': return fromText(field, prefs.salary_expectation ?? '', make);
    case 'notice': return fromText(field, prefs.notice_period ?? '', make);
    case 'change_reason':
    case 'career_goals':
      if (field.type === 'text' || field.type === 'textarea') {
        return make(which === 'change_reason' ? prefs.change_reason : prefs.career_goals);
      }
      return make(null, [], 'Answer this one yourself.');
    case 'locations': return locations(field, prefs.preferred_locations, make);
    case 'arrangement': return arrangement(field, prefs.work_arrangements, make);
    case 'authorization': return authorization(field, prefs.work_authorization_countries, make);
    case 'sponsorship': return sponsorship(field, Boolean(prefs.requires_sponsorship), make);
  }
}

function fromText(field: FormField, text: string, make: Make): PreparedAnswer {
  if (field.type === 'text' || field.type === 'textarea') return make(text);
  if (field.type === 'number') {
    const digits = text.replace(/[,\s]/g, '');
    if (/^\d+(\.\d+)?$/.test(digits)) return make(digits);
    return make(null, [], `Your preference is "${text}", which isn't a single number. Enter the number yourself.`);
  }
  if (field.type === 'select' || field.type === 'radio') {
    const option = matchOption(field, text);
    return option ? make(option) : make(null, [], `Your preference: ${text}. Choose the matching option yourself.`);
  }
  return make(null, [], `Your preference: ${text}.`);
}

function locations(field: FormField, places: string[], make: Make): PreparedAnswer {
  if (field.type === 'text' || field.type === 'textarea') return make(places.join(', '));
  const hits = field.options
    .filter((o) => places.some((p) => norm(p) && (norm(o.label).includes(norm(p)) || norm(p).includes(norm(o.label)))))
    .map((o) => o.value);
  if (field.type === 'checkbox') {
    return hits.length ? make(null, hits) : make(null, [], `Your preference: ${places.join(', ')}. Tick the matching options yourself.`);
  }
  if (hits.length === 1) return make(hits[0]);
  return make(null, [], `Your preference: ${places.join(', ')}. Choose the matching option yourself.`);
}

function arrangement(field: FormField, wanted: string[], make: Make): PreparedAnswer {
  const names = wanted.map((w) => ARRANGEMENT_NAMES[w]).join(' or ');
  if (field.type === 'text' || field.type === 'textarea') return make(names);

  const matches = (optionLabel: string): boolean => {
    const label = norm(optionLabel);
    return wanted.some((w) => (ARRANGEMENT_WORDS[w] ?? []).some((word) => label.includes(word)));
  };
  const hits = field.options.filter((o) => matches(o.label)).map((o) => o.value);
  if (field.type === 'checkbox') {
    return hits.length ? make(null, hits) : make(null, [], `You prefer ${names}. Tick the matching options yourself.`);
  }

  const yesNo = field.options.length > 0 && field.options.every((o) => ['yes', 'no'].includes(norm(o.label)));
  if (yesNo) {
    // "Are you open to remote work?": a Yes only when the question names an arrangement you prefer.
    const label = norm(field.label);
    const named = Object.entries(ARRANGEMENT_WORDS).filter(([, words]) => words.some((w) => label.includes(w))).map(([k]) => k);
    if (named.length === 1 && wanted.includes(named[0] as string)) {
      const option = matchOption(field, 'Yes');
      return option ? make(option) : make(null, [], 'Answer this one yourself.');
    }
    return make(null, [], `You prefer ${names}. Answer this one yourself.`);
  }

  if (hits.length === 1) return make(hits[0]);
  if (hits.length > 1) return make(null, [], `You prefer ${names}. Choose one yourself.`);
  return make(null, [], `You prefer ${names}. Choose the matching option yourself.`);
}

function yesNo(field: FormField, choice: 'Yes' | 'No', make: Make): PreparedAnswer {
  if (field.type === 'text' || field.type === 'textarea') return make(choice);
  const option = matchOption(field, choice);
  if (field.type === 'select' || field.type === 'radio') {
    return option ? make(option) : make(null, [], `Your preferences say "${choice}". Choose the matching option yourself.`);
  }
  if (field.type === 'checkbox' && choice === 'Yes') {
    const yes = matchOption(field, 'Yes');
    return yes ? make(null, [yes]) : make(null, [], 'Tick it yourself if it applies.');
  }
  return make(null, [], 'Answer this one yourself.');
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function authorization(field: FormField, countries: string[], make: Make): PreparedAnswer {
  const label = norm(field.label);
  if (SPONSOR.test(label)) return make(null, [], 'This question combines work authorization and sponsorship. Answer it yourself.');
  if (countries.some((c) => norm(c) && new RegExp(`\\b${escapeRegex(norm(c))}\\b`).test(label))) return yesNo(field, 'Yes', make);
  // Never guess "No": the applicant only said where they ARE authorized.
  return make(null, [], `Your preferences list authorization for ${countries.join(', ')}. This question is about somewhere else: answer it yourself.`);
}

function sponsorship(field: FormField, requires: boolean, make: Make): PreparedAnswer {
  const inverted = INVERTED.test(norm(field.label)); // "Can you work without sponsorship?"
  return yesNo(field, requires !== inverted ? 'Yes' : 'No', make);
}
