import { useEffect, useRef, useState } from 'react';

import { describeError } from '../../lib/api.ts';
import { formatSize, resumesApi } from '../resumes/api.ts';

import type { OnboardingState } from './api.ts';

interface Props {
  state: OnboardingState;
  onEdit: () => void;
  onReplace: () => void;
  onReview: () => void;
  onDeleteProfile: () => Promise<void>;
}

/** What a finished profile looks like on reopening: details, resume, secondary actions. */
export function Summary({ state, onEdit, onReplace, onReview, onDeleteProfile }: Props) {
  const { profile, resume, cv, analysis } = state;
  const [preview, setPreview] = useState<{ kind: 'loading' } | { kind: 'ready'; text: string } | { kind: 'error'; message: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const lifetime = useRef(new AbortController());

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);

  async function togglePreview() {
    if (preview) {
      setPreview(null);
      return;
    }
    if (!resume) return;
    const { signal } = lifetime.current;
    setPreview({ kind: 'loading' });
    try {
      const detail = await resumesApi.get(profile.id, resume.id, signal);
      if (!signal.aborted) setPreview({ kind: 'ready', text: detail.extracted_text });
    } catch (error) {
      if (!signal.aborted) setPreview({ kind: 'error', message: describeError(error) });
    }
  }

  const contact = [profile.email, profile.phone, profile.location].filter(Boolean).join(' · ');
  const skills = cv ? [...cv.skills, ...cv.technologies] : [];
  const latestJob = cv?.work_experience[0];
  const pending = analysis?.status === 'draft';

  return (
    <>
      <article className="profile-card" aria-label="Your profile">
        <p className="badge">Ready</p>
        <h3>{profile.full_name}</h3>
        {latestJob && (latestJob.title || latestJob.company) && (
          <p className="headline">{[latestJob.title, latestJob.company].filter(Boolean).join(' at ')}</p>
        )}
        {contact && <p className="meta">{contact}</p>}
        {profile.linkedin_url && (
          <p className="meta">
            <a href={profile.linkedin_url} target="_blank" rel="noopener noreferrer">
              {profile.linkedin_url.replace(/^https?:\/\/(www\.)?/, '')}
            </a>
          </p>
        )}
        {skills.length > 0 && (
          <p className="meta">
            {skills.slice(0, 6).join(', ')}
            {skills.length > 6 && ` +${skills.length - 6} more`}
          </p>
        )}
        {resume && (
          <p className="resume-line">
            <span className="resume-name" title={resume.original_filename}>{resume.original_filename}</span>
            <span className="tag">{resume.file_type.toUpperCase()}</span>
            <span className="meta">{formatSize(resume.size_bytes)}</span>
          </p>
        )}
      </article>

      {pending && (
        <div className="notice success">
          <span>New details were found in your resume.</span>
          <button type="button" className="btn small primary" onClick={onReview}>
            Review
          </button>
        </div>
      )}

      <div className="actions secondary-actions">
        <button type="button" className="btn small" onClick={onEdit}>
          Edit details
        </button>
        {resume && (
          <button type="button" className="btn small" onClick={() => void togglePreview()} aria-expanded={Boolean(preview)}>
            {preview ? 'Hide resume' : 'Preview resume'}
          </button>
        )}
        <button type="button" className="btn small" onClick={onReplace}>
          Replace resume
        </button>
        {resume?.has_text && !pending && (
          <button type="button" className="btn small" onClick={onReview}>
            Update from resume
          </button>
        )}
      </div>

      {preview?.kind === 'loading' && <p className="hint">Loading resume text…</p>}
      {preview?.kind === 'error' && <p className="notice error">Couldn't load the resume. {preview.message}</p>}
      {preview?.kind === 'ready' &&
        (preview.text ? (
          <pre className="resume-preview" tabIndex={0} aria-label="Resume text">{preview.text}</pre>
        ) : (
          <p className="hint">No readable text was found in this resume (it may be scanned).</p>
        ))}

      {confirmDelete ? (
        <div className="confirm" role="alertdialog" aria-label="Confirm delete">
          <p>
            Delete <strong>{profile.full_name}</strong> with its resumes and details? This can't be undone.
          </p>
          {deleteError && <p className="notice error">{deleteError}</p>}
          <div className="actions">
            <button
              type="button"
              className="btn danger-solid small"
              disabled={deleting}
              onClick={async () => {
                setDeleting(true);
                setDeleteError(null);
                try {
                  await onDeleteProfile();
                } catch (error) {
                  setDeleteError(`Couldn't delete the profile. ${describeError(error)}`);
                  setDeleting(false);
                }
              }}
            >
              {deleting ? 'Deleting…' : 'Delete profile'}
            </button>
            <button type="button" className="btn small" onClick={() => setConfirmDelete(false)} disabled={deleting} autoFocus>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="link-btn danger-link delete-profile" onClick={() => setConfirmDelete(true)}>
          Delete this profile
        </button>
      )}
    </>
  );
}
