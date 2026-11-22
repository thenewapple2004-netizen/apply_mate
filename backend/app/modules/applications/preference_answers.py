"""Answers taken straight from the applicant's saved preferences (never from the AI).

Some of these are sensitive. Salary, work authorization and sponsorship answers
are only *proposed* (`needs_approval`): the extension fills them after the user
approves each one. When a preference isn't set, nothing is invented: the question
is left for the user with a note saying where to add it.
"""

import re

from app.modules.applications.options import match_option, norm
from app.modules.applications.schemas import Answer, FormField
from app.modules.preferences.models import ApplicantPreferences

# Answers that need the user's explicit approval before they are filled.
APPROVAL_KINDS = {"salary", "authorization", "sponsorship"}

_SALARY = re.compile(r"\b(salary|salaries|compensation|remuneration|pay (expectations?|range|requirements?)|expected (pay|ctc|earnings?)|ctc)\b")
_NOTICE = re.compile(r"\b(notice( period)?|how soon (can|could) you (start|join)|when (can|could) you (start|join)|earliest (start|joining)|availability to (start|join)|start date)\b")
_CHANGE = re.compile(r"\b(reason|why)\b.*\b(leav\w*|chang\w*|looking|seeking|switch\w*|mov\w*)\b")
_LOCATIONS = re.compile(r"\b((preferred|desired|ideal) (work )?(locations?|cit(y|ies))|locations? preferences?|where (would|do) you (like|want|prefer) to work)\b")
_ARRANGEMENT = re.compile(r"\b(work(ing)? (arrangement|model|mode|setup|style|preference|type)|remote(ly)?|hybrid|on ?site|in ?office|office based)\b")
_AUTH = re.compile(r"\b(authori[sz]ed|authori[sz]ation|legally (able|eligible|entitled|permitted)|right to work|eligible to work|work permit|work eligibility)\b")
_SPONSOR = re.compile(r"\b(sponsor\w*|visa)\b")
_INVERTED = re.compile(r"\b(without|not (re)?quire|do not (need|require)|don t (need|require)|no need|not need)\b")

_ARRANGEMENT_WORDS = {"remote": ("remote",), "hybrid": ("hybrid",), "onsite": ("on site", "onsite", "in office", "office")}
_ARRANGEMENT_NAMES = {"remote": "Remote", "hybrid": "Hybrid", "onsite": "On-site"}

MISSING = {
    "salary": "Your salary expectation isn't in your Preferences yet. Add it there, or answer here.",
    "notice": "Your notice period isn't in your Preferences yet. Add it there, or answer here.",
    "locations": "Your preferred locations aren't in your Preferences yet. Add them there, or answer here.",
    "arrangement": "Your work arrangement preference isn't in your Preferences yet. Add it there, or answer here.",
    "authorization": "Where you're authorized to work isn't in your Preferences yet. Add it there, or answer here.",
    "sponsorship": "Your sponsorship needs aren't in your Preferences yet. Add them there, or answer here.",
    "change_reason": "Your reason for changing jobs isn't in your Preferences yet. Add it there, or answer here.",
}


def kind(field: FormField) -> str | None:
    """Which preference a question asks about, if it clearly asks about one."""
    if field.type == "checkbox" and len(field.options) == 1:
        return None  # a single tick box is an agreement or declaration, never a preference
    label = norm(field.label)
    auth, sponsor = bool(_AUTH.search(label)), bool(_SPONSOR.search(label))
    if auth and sponsor:
        return "authorization"  # compound: handled as "answer it yourself"
    if sponsor:
        return "sponsorship"
    if auth:
        return "authorization"
    if _SALARY.search(label):
        return "salary"
    if _CHANGE.search(label):
        return "change_reason"
    if _NOTICE.search(label):
        return "notice"
    if _LOCATIONS.search(label):
        return "locations"
    if _ARRANGEMENT.search(label) and "relocat" not in label:
        return "arrangement"
    return None


def is_missing(prefs: ApplicantPreferences | None, which: str) -> bool:
    if prefs is None:
        return True
    return not {
        "salary": prefs.salary_expectation,
        "notice": prefs.notice_period,
        "locations": prefs.preferred_locations,
        "arrangement": prefs.work_arrangements,
        "authorization": prefs.work_authorization_countries,
        "sponsorship": prefs.requires_sponsorship is not None,
        "change_reason": prefs.change_reason,
    }[which]


def missing_answer(field: FormField, which: str) -> Answer:
    return Answer(field_id=field.id, source="none", note=MISSING[which], preference=which)


def answer(field: FormField, which: str, prefs: ApplicantPreferences | None) -> Answer:
    """The answer to a preference question, or a note saying why there isn't one."""
    if is_missing(prefs, which):
        return missing_answer(field, which)
    assert prefs is not None
    approval = which in APPROVAL_KINDS

    def make(value: str | None = None, values: list[str] | None = None, note: str | None = None) -> Answer:
        has = bool(value) or bool(values)
        return Answer(
            field_id=field.id,
            value=value,
            values=values or [],
            source="preference" if has else "none",
            note=None if has else note,
            needs_approval=approval and has,
            preference=which,
        )

    if which == "salary":
        return _from_text(field, prefs.salary_expectation or "", make)
    if which == "notice":
        return _from_text(field, prefs.notice_period or "", make)
    if which == "change_reason":
        if field.type in {"text", "textarea"}:
            return make(value=prefs.change_reason)
        return make(note="Answer this one yourself.")
    if which == "locations":
        return _locations(field, prefs.preferred_locations, make)
    if which == "arrangement":
        return _arrangement(field, prefs.work_arrangements, make)
    if which == "authorization":
        return _authorization(field, prefs.work_authorization_countries, make)
    return _sponsorship(field, bool(prefs.requires_sponsorship), make)


def _from_text(field: FormField, text: str, make) -> Answer:
    if field.type in {"text", "textarea"}:
        return make(value=text)
    if field.type == "number":
        digits = re.sub(r"[,\s]", "", text)
        if re.fullmatch(r"\d+(\.\d+)?", digits):
            return make(value=digits)
        return make(note=f'Your preference is "{text}", which isn\'t a single number. Enter the number yourself.')
    if field.type in {"select", "radio"}:
        option = match_option(field, text)
        return make(value=option) if option else make(note=f"Your preference: {text}. Choose the matching option yourself.")
    return make(note=f"Your preference: {text}.")


def _locations(field: FormField, places: list[str], make) -> Answer:
    if field.type in {"text", "textarea"}:
        return make(value=", ".join(places))
    hits = [
        o.value
        for o in field.options
        if any(norm(p) and (norm(p) in norm(o.label) or norm(o.label) in norm(p)) for p in places)
    ]
    if field.type == "checkbox":
        return make(values=hits) if hits else make(note=f"Your preference: {', '.join(places)}. Tick the matching options yourself.")
    if len(hits) == 1:
        return make(value=hits[0])
    return make(note=f"Your preference: {', '.join(places)}. Choose the matching option yourself.")


def _arrangement(field: FormField, wanted: list[str], make) -> Answer:
    names = " or ".join(_ARRANGEMENT_NAMES[w] for w in wanted)
    if field.type in {"text", "textarea"}:
        return make(value=names)

    def matches(option_label: str) -> bool:
        label = norm(option_label)
        return any(word in label for w in wanted for word in _ARRANGEMENT_WORDS[w])

    hits = [o.value for o in field.options if matches(o.label)]
    if field.type == "checkbox":
        return make(values=hits) if hits else make(note=f"You prefer {names}. Tick the matching options yourself.")

    yes_no = field.options and all(norm(o.label) in {"yes", "no"} for o in field.options)
    if yes_no:
        # "Are you open to remote work?": a Yes only when the question names an arrangement you prefer.
        label = norm(field.label)
        named = [w for w, words in _ARRANGEMENT_WORDS.items() if any(word in label for word in words)]
        if len(named) == 1 and named[0] in wanted:
            option = match_option(field, "Yes")
            return make(value=option) if option else make(note="Answer this one yourself.")
        return make(note=f"You prefer {names}. Answer this one yourself.")

    if len(hits) == 1:
        return make(value=hits[0])
    if len(hits) > 1:
        return make(note=f"You prefer {names}. Choose one yourself.")
    return make(note=f"You prefer {names}. Choose the matching option yourself.")


def _yes_no(field: FormField, choice: str, make) -> Answer:
    if field.type in {"text", "textarea"}:
        return make(value=choice)
    option = match_option(field, choice)
    if field.type in {"select", "radio"}:
        return make(value=option) if option else make(note=f'Your preferences say "{choice}". Choose the matching option yourself.')
    if field.type == "checkbox" and choice == "Yes":
        yes = match_option(field, "Yes")
        return make(values=[yes]) if yes else make(note="Tick it yourself if it applies.")
    return make(note="Answer this one yourself.")


def _authorization(field: FormField, countries: list[str], make) -> Answer:
    label = norm(field.label)
    if _SPONSOR.search(label):
        return make(note="This question combines work authorization and sponsorship. Answer it yourself.")
    if any(re.search(rf"\b{re.escape(norm(c))}\b", label) for c in countries if norm(c)):
        return _yes_no(field, "Yes", make)
    # Never guess "No": the applicant only said where they ARE authorized.
    return make(note=f"Your preferences list authorization for {', '.join(countries)}. This question is about somewhere else: answer it yourself.")


def _sponsorship(field: FormField, requires: bool, make) -> Answer:
    inverted = bool(_INVERTED.search(norm(field.label)))  # "Can you work without sponsorship?"
    return _yes_no(field, "Yes" if requires != inverted else "No", make)
