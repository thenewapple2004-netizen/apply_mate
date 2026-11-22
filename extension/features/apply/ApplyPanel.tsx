import { useEffect, useRef, useState } from 'react';

import { describeError } from '../../lib/api.ts';

import { applyApi, type Job, type PreparedAnswer } from './api.ts';
import {
  type DetectedField,
  detectFields,
  extractJob,
  fillFields,
  type FillInstruction,
  type FillStatus,
} from './page-scripts.ts';
import { shouldRemember } from './sensitivity.ts';
import {
  clearJob,
  clearPrepared,
  type ConfirmedJob,
  loadJob,
  loadPrepared,
  pageKey,
  type PreparedPage,
  saveJob,
  savePrepared,
} from './storage.ts';
import { type CurrentTab, getCurrentTab, runInPage } from './tab.ts';

type Busy = null | 'detecting' | 'preparing' | 'filling';
type Message = { kind: 'error' | 'success' | 'info'; text: string; action?: { label: string; run: () => void } } | null;

const SOURCE_LABEL: Record<PreparedAnswer['source'], string> = {
  profile: 'Profile',
  cv: 'CV',
  saved: 'Saved',
  ai: 'AI',
  user: 'You',
  none: 'Needs you',
};

const FILL_LABEL: Partial<Record<FillStatus, string>> = {
  kept: 'Kept your value',
  not_found: "Couldn't find it on the page",
  no_option: 'Option not available on the page',
  failed: "Couldn't fill",
};

const hasAnswer = (a: PreparedAnswer) => (a.value !== null && a.value.trim() !== '') || a.values.length > 0;
const plain = (error: unknown) => describeError(error).replace(/^Unexpected error: /, '');

/** Detect job -> prepare answers -> review -> fill the current page. */
export function ApplyPanel({ profileId }: { profileId: string }) {
  const [tab, setTab] = useState<CurrentTab | null>(null);
  const [job, setJob] = useState<ConfirmedJob | null>(null);
  const [draft, setDraft] = useState<Job | null>(null);
  const [showJD, setShowJD] = useState(false);
  const [page, setPage] = useState<PreparedPage | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [message, setMessage] = useState<Message>(null);
  const [composing, setComposing] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    void (async () => {
      const [storedJob, current] = await Promise.all([loadJob(profileId), getCurrentTab().catch(() => null)]);
      if (!alive.current) return;
      setJob(storedJob);
      setTab(current);
      if (current && storedJob) setPage(await loadPrepared(profileId, storedJob, current.url));
    })();
    return () => {
      alive.current = false;
    };
  }, [profileId]);

  async function withTab(): Promise<CurrentTab> {
    const current = await getCurrentTab(); // re-read: the tab may have navigated
    setTab(current);
    return current;
  }

  // ---- job ------------------------------------------------------------------------

  async function detectJob() {
    setMessage(null);
    setBusy('detecting');
    try {
      const current = await withTab();
      const found = await runInPage(current.id, extractJob);
      if (!alive.current) return;
      const { source: _source, ...detected } = found;
      setDraft(detected);
      if (!found.description) {
        setMessage({
          kind: 'info',
          text: found.title
            ? "No job description found on this page (application forms often don't include it). Detect it on the job posting, or paste it below."
            : 'No job posting found on this page. Type or paste the details instead.',
        });
      }
    } catch (error) {
      setMessage({ kind: 'error', text: plain(error) });
    } finally {
      if (alive.current) setBusy(null);
    }
  }

  async function confirmJob() {
    if (!draft) return;
    if (!draft.title.trim() && !draft.description.trim()) {
      setMessage({ kind: 'error', text: 'Add at least the job title or description.' });
      return;
    }
    // A new job never reuses answers prepared for the previous one.
    const confirmed = await saveJob(profileId, draft, job);
    if (!alive.current) return;
    setJob(confirmed);
    setPage(null);
    setDraft(null);
    setMessage(null);
  }

  // ---- answers -------------------------------------------------------------------------

  async function prepareAnswers(refresh = false) {
    if (!job) return;
    setMessage(null);
    setBusy('preparing');
    try {
      const current = await withTab();
      const detection = await runInPage(current.id, detectFields);
      if (!alive.current) return;
      if (!detection.fields.length) {
        if (detection.embeddedForm) {
          const formUrl = detection.embeddedForm;
          setMessage({
            kind: 'info',
            text: `This application form is embedded from ${new URL(formUrl).hostname}, which Job Fellow can't read from here. Open the form on its own page, then prepare answers there.`,
            action: { label: 'Open the form', run: () => void browser.tabs.update(current.id, { url: formUrl }) },
          });
        } else {
          const skipped = detection.unsupported.length
            ? ` Found only fields Job Fellow can't fill: ${detection.unsupported.map((u) => u.label).join(', ')}.`
            : '';
          setMessage({ kind: 'info', text: `No questions Job Fellow can fill were found on this page.${skipped} Open the application form and try again.` });
        }
        return;
      }
      const { id: _id, profileId: _p, confirmedAt: _c, ...jobData } = job;
      const result = await applyApi.prepare(profileId, jobData, detection.fields, refresh);
      if (!alive.current) return;
      const next: PreparedPage = {
        profileId,
        jobId: job.id,
        page: pageKey(current.url),
        createdAt: new Date().toISOString(),
        fields: detection.fields,
        unsupported: detection.unsupported,
        answers: result.answers,
        aiError: result.ai_error,
        cacheHits: result.cache_hits,
        fillStatus: null,
      };
      setPage(next);
      await savePrepared(next);
    } catch (error) {
      if (alive.current) setMessage({ kind: 'error', text: `Couldn't prepare answers. ${plain(error)}` });
    } finally {
      if (alive.current) setBusy(null);
    }
  }

  function editAnswer(fieldId: string, patch: Partial<PreparedAnswer>) {
    if (!page) return;
    const next = {
      ...page,
      answers: page.answers.map((a) => (a.field_id === fieldId ? { ...a, ...patch, source: 'user' as const } : a)),
    };
    setPage(next);
    void savePrepared(next);
  }

  /** The user clicked a suggested choice for a text question: word it as their answer. */
  async function chooseSuggestion(field: DetectedField, choice: string) {
    if (!job || !page) return;
    setComposing(field.id);
    try {
      const { id: _id, profileId: _p, confirmedAt: _c, ...jobData } = job;
      const result = await applyApi.compose(profileId, jobData, field.label, field.type, choice);
      if (alive.current) editAnswer(field.id, { value: result.value });
    } catch (error) {
      // AI unavailable: the choice itself is still a valid answer.
      if (alive.current) {
        editAnswer(field.id, { value: choice });
        setMessage({ kind: 'info', text: `Used "${choice}" as written; AI couldn't phrase it (${plain(error)}).` });
      }
    } finally {
      if (alive.current) setComposing(null);
    }
  }

  async function fill() {
    if (!page) return;
    setMessage(null);
    setBusy('filling');
    try {
      const current = await withTab();
      if (pageKey(current.url) !== page.page) {
        setMessage({ kind: 'error', text: 'This tab is now showing a different page. Prepare answers again for this page.' });
        return;
      }
      const fields = new Map(page.fields.map((f) => [f.id, f]));
      const instructions: FillInstruction[] = page.answers.filter(hasAnswer).flatMap((a) => {
        const f = fields.get(a.field_id);
        return f ? [{ id: f.id, type: f.type, widget: f.widget, locator: f.locator, value: a.value, values: a.values }] : [];
      });
      const outcome = await runInPage(current.id, fillFields, instructions);
      const status = Object.fromEntries(outcome.results.map((r) => [r.id, r.status])) as Record<string, FillStatus>;
      const next = { ...page, fillStatus: status };
      setPage(next);
      await savePrepared(next);
      void rememberAnswers(next);

      const count = (s: FillStatus[]) => outcome.results.filter((r) => s.includes(r.status)).length;
      const filled = count(['filled', 'unchanged']);
      const kept = count(['kept']);
      const failed = count(['not_found', 'no_option', 'failed']);
      const blank = page.answers.length - instructions.length;
      const parts = [`Filled ${filled} field${filled === 1 ? '' : 's'}.`];
      if (kept) parts.push(`Kept ${kept} value${kept === 1 ? '' : 's'} you'd already entered.`);
      if (failed) parts.push(`${failed} couldn't be filled (marked below).`);
      if (blank) parts.push(`${blank} left for you.`);
      if (outcome.newFields) parts.push(`${outcome.newFields} new question${outcome.newFields === 1 ? '' : 's'} appeared; use "Prepare again" to answer them.`);
      parts.push('Check the page, then submit it yourself.');
      setMessage({ kind: failed ? 'info' : 'success', text: parts.join(' ') });
    } catch (error) {
      setMessage({ kind: 'error', text: `Couldn't fill the page. ${plain(error)}` });
    } finally {
      if (alive.current) setBusy(null);
    }
  }

  /** Approved answers that were verified on the page are reused next time.
   *  Consent, sensitive and job-specific answers are never saved. */
  async function rememberAnswers(prepared: PreparedPage) {
    const byId = new Map(prepared.fields.map((f) => [f.id, f]));
    const items = prepared.answers.flatMap((a) => {
      const field = byId.get(a.field_id);
      if (!field || !shouldRemember(field, a, prepared.fillStatus?.[a.field_id])) return [];
      const label = (v: string) => field.options.find((o) => o.value === v)?.label ?? v;
      const answer = field.type === 'checkbox' ? a.values.map(label).join('; ') : field.options.length ? label(a.value!) : a.value!;
      return [{ question: field.label, answer }];
    });
    if (items.length) await applyApi.saveAnswers(prepared.profileId, items).catch(() => undefined);
  }

  // ---- view --------------------------------------------------------------------------------

  const answered = page ? page.answers.filter(hasAnswer).length : 0;
  const step = !job ? 2 : !page ? 3 : page.fillStatus ? 5 : 4;

  return (
    <section className="apply" aria-labelledby="apply-title">
      <h3 id="apply-title" className="sr-only">Apply</h3>
      <ol className="steps compact" aria-label="Application progress">
        {['Profile', 'Job', 'Answers', 'Review', 'Fill'].map((label, i) => (
          <li key={label} className={i + 1 < step ? 'done' : i + 1 === step ? 'current' : undefined} aria-current={i + 1 === step ? 'step' : undefined}>
            {label}
          </li>
        ))}
      </ol>

      {message && (
        <div className={`notice ${message.kind === 'info' ? 'warn' : message.kind}`} role={message.kind === 'error' ? 'alert' : 'status'}>
          <span>{message.text}</span>
          {message.action && (
            <button type="button" className="btn small" onClick={message.action.run}>
              {message.action.label}
            </button>
          )}
        </div>
      )}

      {/* Job ------------------------------------------------------------------------ */}
      {draft ? (
        <div className="step-card">
          <h3>Confirm the job</h3>
          <label className="cv-field">
            <span>Job title</span>
            <input type="text" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          </label>
          <label className="cv-field">
            <span>Company</span>
            <input type="text" value={draft.company} onChange={(e) => setDraft({ ...draft, company: e.target.value })} />
          </label>
          <label className="cv-field">
            <span>Job description</span>
            <textarea rows={7} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          </label>
          <div className="actions">
            <button type="button" className="btn primary" onClick={() => void confirmJob()}>
              Confirm job
            </button>
            <button type="button" className="btn" onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : job ? (
        <div className="job-card">
          <div className="job-head">
            <div>
              <strong>{job.title || 'Untitled job'}</strong>
              {job.company && <span className="meta"> · {job.company}</span>}
            </div>
            <div className="actions">
              <button type="button" className="link-btn" onClick={() => setShowJD(!showJD)} aria-expanded={showJD}>
                {showJD ? 'Hide' : 'JD'}
              </button>
              <button type="button" className="link-btn" onClick={() => void detectJob()} disabled={busy !== null}>
                Change
              </button>
              <button
                type="button"
                className="link-btn"
                onClick={async () => {
                  await clearJob(profileId, job);
                  setJob(null);
                  setPage(null);
                  setMessage(null);
                }}
              >
                Clear
              </button>
            </div>
          </div>
          {showJD && <pre className="resume-preview">{job.description || 'No description.'}</pre>}
        </div>
      ) : (
        <div className="step-card">
          <h3>Find the job</h3>
          <p className="hint">Open the job posting, then detect it. You'll confirm the details before they're used.</p>
          <div className="actions">
            <button type="button" className="btn primary" onClick={() => void detectJob()} disabled={busy !== null}>
              {busy === 'detecting' ? 'Detecting…' : 'Detect job on this page'}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => setDraft({ title: '', company: '', description: '', url: tab?.url ?? '' })}
            >
              Enter manually
            </button>
          </div>
        </div>
      )}

      {/* Answers -------------------------------------------------------------------- */}
      {job && !draft && (
        <>
          {busy === 'preparing' ? (
            <div className="step-card analyzing" role="status">
              <span className="spinner" aria-hidden="true" />
              <span>Reading the form and preparing answers… Keep this popup open.</span>
            </div>
          ) : !page ? (
            <div className="step-card">
              <h3>Prepare answers</h3>
              <p className="hint">On the application form, Job Fellow reads the questions and prepares answers from your profile, CV and saved answers. Nothing is filled until you approve.</p>
              <div className="actions">
                <button type="button" className="btn primary" onClick={() => void prepareAnswers()} disabled={busy !== null}>
                  Prepare answers for this page
                </button>
              </div>
            </div>
          ) : (
            <AnswerReview
              page={page}
              answered={answered}
              busy={busy}
              composing={composing}
              onEdit={editAnswer}
              onChoose={(field, choice) => void chooseSuggestion(field, choice)}
              onFill={() => void fill()}
              onRegenerate={async () => {
                await clearPrepared(page);
                setPage(null);
                await prepareAnswers(true);
              }}
              onRedo={async () => {
                await clearPrepared(page);
                setPage(null);
                setMessage(null);
              }}
            />
          )}
        </>
      )}
    </section>
  );
}

function AnswerReview(props: {
  page: PreparedPage;
  answered: number;
  busy: Busy;
  composing: string | null;
  onEdit: (fieldId: string, patch: Partial<PreparedAnswer>) => void;
  onChoose: (field: DetectedField, choice: string) => void;
  onFill: () => void;
  onRedo: () => void;
  onRegenerate: () => void;
}) {
  const { page } = props;
  const fields = new Map(page.fields.map((f) => [f.id, f]));
  const missingRequired = page.answers.filter((a) => !hasAnswer(a) && fields.get(a.field_id)?.required).length;
  return (
    <div className="step-card review">
      <div className="job-head">
        <h3>Review answers</h3>
        <div className="actions">
          <button
            type="button"
            className="link-btn"
            onClick={props.onRegenerate}
            disabled={props.busy !== null}
            title="Ask the AI again instead of reusing earlier answers"
          >
            Regenerate
          </button>
          <button type="button" className="link-btn" onClick={props.onRedo} disabled={props.busy !== null}>
            Prepare again
          </button>
        </div>
      </div>
      <p className="hint">
        {props.answered} of {page.answers.length} questions answered.
        {(page.cacheHits ?? 0) > 0 && ` ${page.cacheHits} reused instantly from earlier applications.`}
        {missingRequired > 0 && ` ${missingRequired} required question${missingRequired === 1 ? '' : 's'} still need${missingRequired === 1 ? 's' : ''} your input.`}{' '}
        Edit anything; clear what you don't want filled.
      </p>
      {page.aiError && (
        <p className="notice warn">AI answers aren't available: {page.aiError} Profile and saved answers are still used.</p>
      )}
      {page.unsupported.length > 0 && (
        <div className="notice warn">
          <div>
            <strong>Fill these yourself:</strong>
            <ul>
              {page.unsupported.map((u, i) => (
                <li key={i}>
                  {u.label}: {u.reason.replace(/^[^:]+: /, '')}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      <div className="answers">
        {page.answers.map((answer) => {
          const field = fields.get(answer.field_id);
          return field ? (
            <AnswerRow
              key={answer.field_id}
              field={field}
              answer={answer}
              status={page.fillStatus?.[field.id]}
              composing={props.composing === field.id}
              disabled={props.composing !== null}
              onEdit={props.onEdit}
              onChoose={props.onChoose}
            />
          ) : null;
        })}
      </div>
      <div className="form-footer column">
        <button type="button" className="btn primary" onClick={props.onFill} disabled={props.busy !== null || props.answered === 0}>
          {props.busy === 'filling' ? 'Filling…' : page.fillStatus ? `Fill again (${props.answered})` : `Fill ${props.answered} fields on this page`}
        </button>
        <span className="hint">Job Fellow never clicks Next, Apply or Submit, and keeps values you've typed yourself.</span>
      </div>
    </div>
  );
}

function AnswerRow({
  field,
  answer,
  status,
  composing,
  disabled,
  onEdit,
  onChoose,
}: {
  field: DetectedField;
  answer: PreparedAnswer;
  status: FillStatus | undefined;
  composing: boolean;
  disabled: boolean;
  onEdit: (id: string, patch: Partial<PreparedAnswer>) => void;
  onChoose: (field: DetectedField, choice: string) => void;
}) {
  // One-click choices for a question that still needs the user.
  let chips: { label: string; pick: () => void }[] = [];
  if (!hasAnswer(answer)) {
    if ((field.type === 'select' || field.type === 'radio') && field.options.length <= 8) {
      chips = field.options.map((o) => ({ label: o.label, pick: () => onEdit(field.id, { value: o.value }) }));
    } else if (field.type === 'text' || field.type === 'textarea' || field.type === 'number') {
      chips = (answer.suggestions ?? []).map((s) => ({
        label: s.label,
        // Pre-written answers apply instantly; otherwise the backend words the choice.
        pick: () => (s.answer ? onEdit(field.id, { value: s.answer }) : onChoose(field, s.label)),
      }));
    }
  }
  const id = `answer-${field.id}`;
  const source = hasAnswer(answer) ? answer.source : 'none';
  let control;
  if (field.type === 'textarea') {
    control = <textarea id={id} rows={4} value={answer.value ?? ''} onChange={(e) => onEdit(field.id, { value: e.target.value })} />;
  } else if (field.type === 'select' || field.type === 'radio') {
    control = (
      <select id={id} value={answer.value ?? ''} onChange={(e) => onEdit(field.id, { value: e.target.value || null })}>
        <option value="">Leave blank</option>
        {field.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  } else if (field.type === 'checkbox') {
    control = (
      <div className="check-list" role="group" aria-labelledby={`${id}-label`}>
        {field.options.map((o) => (
          <label key={o.value} className="check">
            <input
              type="checkbox"
              checked={answer.values.includes(o.value)}
              onChange={(e) =>
                onEdit(field.id, {
                  values: e.target.checked ? [...answer.values, o.value] : answer.values.filter((v) => v !== o.value),
                })
              }
            />
            {field.options.length === 1 ? 'Tick this box' : o.label}
          </label>
        ))}
      </div>
    );
  } else {
    control = <input id={id} type="text" value={answer.value ?? ''} onChange={(e) => onEdit(field.id, { value: e.target.value })} />;
  }

  const problem = status ? FILL_LABEL[status] : undefined;
  return (
    <div className={`answer-row cv-field${problem && status !== 'kept' ? ' invalid' : ''}`}>
      <div className="answer-label">
        <label htmlFor={id} id={`${id}-label`}>
          {field.label || 'Unlabelled field'}
          {field.required && <span aria-hidden="true"> *</span>}
        </label>
        <span className={`source ${source}`}>{SOURCE_LABEL[source]}</span>
      </div>
      {chips.length > 0 && (
        <div className="chips" role="group" aria-label={`Quick answers for: ${field.label}`}>
          {chips.map((chip) => (
            <button key={chip.label} type="button" className="chip" onClick={chip.pick} disabled={disabled}>
              {chip.label}
            </button>
          ))}
          {composing && <span className="hint">Writing your answer…</span>}
        </div>
      )}
      {control}
      {problem && <span className={status === 'kept' ? 'hint' : 'field-error'}>{problem}</span>}
      {answer.note && !hasAnswer(answer) && <span className="hint">{answer.note}</span>}
    </div>
  );
}
