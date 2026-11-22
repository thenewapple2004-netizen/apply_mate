import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError, apiRequest, describeError } from '../../lib/api.ts';
import type { Profile } from '../profiles/api.ts';
import type { Resume } from '../resumes/api.ts';

import { type CVAnalysis, type CVData, type CVDetails, cvApi, EMPTY_CV, toCVData } from './api.ts';
import { CVEditor } from './CVEditor.tsx';

interface Props {
  profileId: string;
  /** Present when opened from "Analyze CV" on a resume. */
  resumeId: string | null;
}

/**
 * What the page is showing:
 * - consent:   asking permission before sending the resume to Gemini
 * - analyzing: waiting for Gemini
 * - draft:     reviewing an unconfirmed AI draft
 * - saved:     viewing/editing the confirmed details
 */
type View = 'loading' | 'load-error' | 'consent' | 'analyzing' | 'draft' | 'saved';

const when = (iso: string) => new Date(iso).toLocaleString();

export function CVPage({ profileId, resumeId }: Props) {
  const [view, setView] = useState<View>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [resume, setResume] = useState<Resume | null>(null);
  const [analysis, setAnalysis] = useState<CVAnalysis | null>(null);
  const [saved, setSaved] = useState<CVDetails | null>(null);
  const [form, setForm] = useState<CVData>(EMPTY_CV);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const lifetime = useRef(new AbortController());

  const load = useCallback(async () => {
    const { signal } = lifetime.current;
    setView('loading');
    const optional = <T,>(p: Promise<T>) =>
      p.catch((e) => {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      });
    try {
      const base = `/api/v1/profiles/${encodeURIComponent(profileId)}`;
      const [p, details, r, draft] = await Promise.all([
        apiRequest<Profile>(base, { signal }),
        optional(cvApi.getDetails(profileId, signal)),
        resumeId
          ? apiRequest<Resume>(`${base}/resumes/${encodeURIComponent(resumeId)}`, { signal })
          : Promise.resolve(null),
        resumeId ? optional(cvApi.getDraft(profileId, resumeId, signal)) : Promise.resolve(null),
      ]);
      if (signal.aborted) return;
      setProfile(p);
      setSaved(details);
      setResume(r);
      setAnalysis(draft);
      if (draft && draft.status === 'draft') {
        setForm(draft.data);
        setView('draft');
      } else if (resumeId) {
        setView('consent');
      } else {
        setForm(details ? toCVData(details) : EMPTY_CV);
        setView('saved');
      }
    } catch (error) {
      if (signal.aborted) return;
      setLoadError(
        error instanceof ApiError && error.status === 404
          ? 'This profile or resume no longer exists.'
          : describeError(error),
      );
      setView('load-error');
    }
  }, [profileId, resumeId]);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    void load();
    return () => controller.abort();
  }, [load]);

  // Warn before closing the tab with unsaved edits.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  useEffect(() => {
    document.title = profile ? `CV details – ${profile.full_name} – ApplyMate` : 'CV details – ApplyMate';
  }, [profile]);

  async function runAnalysis() {
    if (!resumeId) return;
    const { signal } = lifetime.current;
    setMessage(null);
    setErrors({});
    setView('analyzing');
    try {
      const result = await cvApi.analyze(profileId, resumeId, signal);
      if (signal.aborted) return;
      setAnalysis(result);
      setForm(result.data);
      setDirty(false);
      setView('draft');
    } catch (error) {
      if (signal.aborted) return;
      setMessage({ kind: 'error', text: `Analysis failed. ${describeError(error)}` });
      setView('consent');
    }
  }

  async function save() {
    // Only confirming a draft links it as the source. Editing saved details sends
    // no source, so the backend keeps the existing one (and a newer, unreviewed
    // draft for the same resume is never marked as confirmed by accident).
    const sourceId = view === 'draft' ? (analysis?.id ?? null) : null;
    setSaving(true);
    setMessage(null);
    setErrors({});
    try {
      const result = await cvApi.saveDetails(profileId, toCVData(form), sourceId);
      setSaved(result);
      setForm(toCVData(result));
      if (view === 'draft' && analysis) setAnalysis({ ...analysis, status: 'confirmed' });
      setDirty(false);
      setView('saved');
      setMessage({ kind: 'success', text: 'Saved. These are now your confirmed CV details.' });
    } catch (error) {
      if (error instanceof ApiError && Object.keys(error.fieldErrors).length > 0) {
        setErrors(error.fieldErrors);
        // List the problems too, so one that isn't next to a visible field is never hidden.
        const details = Object.entries(error.fieldErrors)
          .slice(0, 3)
          .map(([path, msg]) => `${path.replaceAll('_', ' ')}: ${msg}`)
          .join('; ');
        setMessage({ kind: 'error', text: `Some fields need attention (${details}).` });
      } else {
        setMessage({ kind: 'error', text: `Couldn't save. ${describeError(error)}` });
      }
    } finally {
      setSaving(false);
    }
  }

  const edit = (next: CVData) => {
    setForm(next);
    setDirty(true);
  };

  return (
    <main className="cv-page">
      <header className="cv-header">
        <div className="brand">
          <img src="/icon/48.png" alt="" className="brand-icon" />
          <span className="brand-name">ApplyMate</span>
        </div>
        <h1>CV details{profile && <> for <span className="who">{profile.full_name}</span></>}</h1>
        {resume && <p className="hint">Resume: {resume.original_filename}</p>}
      </header>

      {message && (
        <p className={`notice ${message.kind}`} role={message.kind === 'error' ? 'alert' : 'status'}>
          {message.text}
        </p>
      )}

      {view === 'loading' && <p className="hint">Loading…</p>}

      {view === 'load-error' && (
        <div className="notice error" role="alert">
          <span>{loadError}</span>
          <button type="button" className="btn small" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}

      {view === 'consent' && resume && (
        <section className="consent" aria-labelledby="consent-title">
          <h2 id="consent-title">Analyze this CV with Google Gemini?</h2>
          <ul>
            <li>
              The text extracted from <strong>{resume.original_filename}</strong> will be sent to{' '}
              <strong>Google Gemini</strong>, an external AI service, to identify your summary,
              skills, experience, education, projects and certifications.
            </li>
            <li>The file itself isn't sent, only its text. Google's Gemini API terms apply to how it is processed.</li>
            <li>
              The result is a <strong>draft</strong>. Nothing is saved to your profile until you review it
              and click <em>Confirm and save</em>.
            </li>
            {saved && <li>Your current confirmed CV details won't change unless you confirm the new draft.</li>}
          </ul>
          {!resume.has_text && (
            <p className="notice error">This resume has no readable text, so it can't be analyzed.</p>
          )}
          <div className="actions">
            <button type="button" className="btn primary" onClick={() => void runAnalysis()} disabled={!resume.has_text}>
              I agree, analyze with Gemini
            </button>
            {saved || analysis ? (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setMessage(null);
                  if (analysis?.status === 'draft') {
                    setForm(analysis.data);
                    setView('draft');
                  } else {
                    setForm(saved ? toCVData(saved) : EMPTY_CV);
                    setView('saved');
                  }
                }}
              >
                Cancel
              </button>
            ) : (
              <button type="button" className="btn" onClick={() => window.close()}>
                Cancel
              </button>
            )}
          </div>
        </section>
      )}

      {view === 'analyzing' && (
        <div className="analyzing" role="status">
          <span className="spinner" aria-hidden="true" />
          Analyzing with Gemini… this can take up to a minute.
        </div>
      )}

      {view === 'draft' && analysis && (
        <>
          <div className="banner draft">
            <strong>AI draft, not saved yet.</strong> Gemini ({analysis.model}) extracted this on{' '}
            {when(analysis.analyzed_at)}. Check every field, correct mistakes and add anything missing,
            then confirm.
            {saved && (
              <>
                {' '}
                Confirming will <strong>replace</strong> the CV details you saved on {when(saved.confirmed_at)}.
              </>
            )}
          </div>
          {analysis.warnings.length > 0 && (
            <div className="banner warn" role="note">
              <strong>Please double-check:</strong>
              <ul>
                {analysis.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          )}
          <CVEditor value={form} onChange={edit} errors={errors} disabled={saving} />
          <div className="cv-footer">
            <button type="button" className="btn primary" onClick={() => void save()} disabled={saving}>
              {saving ? 'Saving…' : saved ? 'Confirm and replace saved details' : 'Confirm and save'}
            </button>
            <button type="button" className="btn" onClick={() => setView('consent')} disabled={saving}>
              Analyze again
            </button>
            {saved && (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setForm(toCVData(saved));
                  setDirty(false);
                  setView('saved');
                }}
                disabled={saving}
              >
                View saved details
              </button>
            )}
          </div>
        </>
      )}

      {view === 'saved' && (
        <>
          {saved ? (
            <div className="banner confirmed">
              <strong>Confirmed CV details.</strong> Last saved {when(saved.confirmed_at)}. Edit anything
              below and save.
            </div>
          ) : (
            <div className="banner">
              No confirmed CV details yet. Analyze a resume from the ApplyMate popup, or fill these in
              yourself and save.
            </div>
          )}
          {analysis?.status === 'draft' && (
            <p className="hint">
              There's an unconfirmed draft for this resume.{' '}
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  setForm(analysis.data);
                  setView('draft');
                }}
              >
                Review draft
              </button>
            </p>
          )}
          <CVEditor value={form} onChange={edit} errors={errors} disabled={saving} />
          <div className="cv-footer">
            <button type="button" className="btn primary" onClick={() => void save()} disabled={saving || (!dirty && !!saved)}>
              {saving ? 'Saving…' : 'Save changes'}
            </button>
            {resumeId && (
              <button type="button" className="btn" onClick={() => setView('consent')} disabled={saving}>
                Analyze resume again
              </button>
            )}
          </div>
        </>
      )}
    </main>
  );
}
