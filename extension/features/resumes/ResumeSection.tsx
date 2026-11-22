import { type ChangeEvent, useCallback, useEffect, useRef, useState } from 'react';

import { ApiError } from '../../lib/api.ts';

import {
  checkFileBeforeUpload,
  formatSize,
  type Resume,
  resumesApi,
} from './api.ts';

interface Props {
  /** The active profile. Render with key={profileId} so switching profiles starts fresh. */
  profileId: string;
}

type ListState = { kind: 'loading' } | { kind: 'ready' } | { kind: 'error'; message: string };
type Preview =
  | { id: string; kind: 'loading' }
  | { id: string; kind: 'ready'; text: string }
  | { id: string; kind: 'error'; message: string };

const ACCEPT =
  '.pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function describe(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.kind === 'network') return 'The backend is offline.';
    if (error.kind === 'timeout') return 'The request timed out.';
    return error.message;
  }
  return 'Something went wrong.';
}

const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

export function ResumeSection({ profileId }: Props) {
  const [resumes, setResumes] = useState<Resume[]>([]);
  const [list, setList] = useState<ListState>({ kind: 'loading' });
  const [upload, setUpload] = useState<{ name: string; progress: number } | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // Aborted when this section unmounts (e.g. the profile changes), so nothing
  // from a previous profile can arrive after the switch.
  const lifetime = useRef<AbortController>(new AbortController());

  const loadList = useCallback(async () => {
    const { signal } = lifetime.current;
    setList({ kind: 'loading' });
    try {
      const items = await resumesApi.list(profileId, signal);
      if (signal.aborted) return;
      setResumes(items);
      setList({ kind: 'ready' });
    } catch (error) {
      if (!signal.aborted) setList({ kind: 'error', message: describe(error) });
    }
  }, [profileId]);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    void loadList();
    return () => controller.abort();
  }, [loadList]);

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = ''; // allow choosing the same file again
    if (!file) return;

    setUploadError(null);
    setActionError(null);
    const problem = checkFileBeforeUpload(file);
    if (problem) {
      setUploadError(`${file.name}: ${problem}`);
      return;
    }

    const { signal } = lifetime.current;
    setUpload({ name: file.name, progress: 0 });
    try {
      const created = await resumesApi.upload(profileId, file, {
        signal,
        onProgress: (progress) => setUpload({ name: file.name, progress }),
      });
      if (signal.aborted) return;
      setResumes((items) => [...items, created]);
    } catch (error) {
      if (signal.aborted || isAbort(error)) return;
      setUploadError(`${file.name}: ${describe(error)}`);
    } finally {
      if (!signal.aborted) setUpload(null);
    }
  }

  async function togglePrimary(resume: Resume) {
    const { signal } = lifetime.current;
    setBusyId(resume.id);
    setActionError(null);
    try {
      const updated = await resumesApi.setPrimary(profileId, resume.id, !resume.is_primary);
      if (signal.aborted) return;
      setResumes((items) =>
        items.map((r) =>
          r.id === updated.id ? updated : updated.is_primary ? { ...r, is_primary: false } : r,
        ),
      );
    } catch (error) {
      if (!signal.aborted) setActionError(`Couldn't update the primary resume. ${describe(error)}`);
    } finally {
      if (!signal.aborted) setBusyId(null);
    }
  }

  async function remove(resume: Resume) {
    const { signal } = lifetime.current;
    setBusyId(resume.id);
    setActionError(null);
    try {
      await resumesApi.remove(profileId, resume.id);
    } catch (error) {
      if (signal.aborted) return;
      if (!(error instanceof ApiError && error.status === 404)) {
        setActionError(`Couldn't delete the resume. ${describe(error)}`);
        setBusyId(null);
        return;
      }
      // 404: already gone, so finish removing it locally.
    }
    if (signal.aborted) return;
    setResumes((items) => items.filter((r) => r.id !== resume.id));
    setConfirmDeleteId(null);
    if (preview?.id === resume.id) setPreview(null);
    setBusyId(null);
  }

  async function togglePreview(resume: Resume) {
    if (preview?.id === resume.id) {
      setPreview(null);
      return;
    }
    if (!resume.has_text) {
      setPreview({ id: resume.id, kind: 'ready', text: '' });
      return;
    }
    const { signal } = lifetime.current;
    setPreview({ id: resume.id, kind: 'loading' });
    try {
      const detail = await resumesApi.get(profileId, resume.id, signal);
      if (signal.aborted) return;
      // Ignore a late answer if the user has since opened a different preview.
      setPreview((current) =>
        current?.id === resume.id ? { id: resume.id, kind: 'ready', text: detail.extracted_text } : current,
      );
    } catch (error) {
      if (signal.aborted) return;
      setPreview((current) =>
        current?.id === resume.id ? { id: resume.id, kind: 'error', message: describe(error) } : current,
      );
    }
  }

  const uploading = upload !== null;

  return (
    <section className="resumes" aria-labelledby="resumes-title">
      <div className="section-head">
        <h4 id="resumes-title">Resumes</h4>
        <button
          type="button"
          className="link-btn"
          onClick={() => fileInput.current?.click()}
          disabled={uploading || list.kind !== 'ready'}
        >
          + Upload resume
        </button>
        <input
          ref={fileInput}
          type="file"
          accept={ACCEPT}
          onChange={(e) => void handleFile(e)}
          hidden
          aria-label="Choose a PDF or DOCX resume"
        />
      </div>

      {upload && (
        <div className="upload" role="status">
          <span className="upload-label">
            {upload.progress < 1
              ? `Uploading ${upload.name}… ${Math.round(upload.progress * 100)}%`
              : `Reading ${upload.name}…`}
          </span>
          <progress value={upload.progress} max={1} />
        </div>
      )}

      {uploadError && (
        <div className="notice error" role="alert">
          <span>{uploadError}</span>
          <button type="button" className="btn small" onClick={() => setUploadError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {actionError && (
        <p className="notice error" role="alert">
          {actionError}
        </p>
      )}

      {list.kind === 'loading' && <p className="hint">Loading resumes…</p>}

      {list.kind === 'error' && (
        <div className="notice error" role="alert">
          <span>Couldn't load resumes. {list.message}</span>
          <button type="button" className="btn small" onClick={() => void loadList()}>
            Retry
          </button>
        </div>
      )}

      {list.kind === 'ready' && resumes.length === 0 && !uploading && (
        <p className="hint">No resumes yet. Upload a PDF or DOCX file (up to 10 MB).</p>
      )}

      {resumes.length > 0 && (
        <ul className="resume-list">
          {resumes.map((resume) => {
            const busy = busyId === resume.id;
            const open = preview?.id === resume.id ? preview : null;
            return (
              <li key={resume.id} className={resume.is_primary ? 'resume primary' : 'resume'}>
                <div className="resume-title">
                  <span className="resume-name" title={resume.original_filename}>
                    {resume.original_filename}
                  </span>
                  <span className="tag">{resume.file_type.toUpperCase()}</span>
                  {resume.is_primary && <span className="tag accent">Primary</span>}
                </div>
                <p className="resume-meta">
                  {formatSize(resume.size_bytes)}
                  {resume.has_text ? '' : ' · No readable text'}
                </p>

                {confirmDeleteId === resume.id ? (
                  <div className="confirm inline" role="alertdialog" aria-label="Confirm delete">
                    <p>
                      Delete <strong>{resume.original_filename}</strong>? This can't be undone.
                    </p>
                    <div className="actions">
                      <button
                        type="button"
                        className="btn danger-solid small"
                        onClick={() => void remove(resume)}
                        disabled={busy}
                      >
                        {busy ? 'Deleting…' : 'Delete resume'}
                      </button>
                      <button
                        type="button"
                        className="btn small"
                        onClick={() => setConfirmDeleteId(null)}
                        disabled={busy}
                        autoFocus
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="actions">
                    <button
                      type="button"
                      className="btn small"
                      onClick={() => void togglePreview(resume)}
                      aria-expanded={Boolean(open)}
                    >
                      {open ? 'Hide text' : 'Preview text'}
                    </button>
                    <button
                      type="button"
                      className="btn small"
                      onClick={() => void togglePrimary(resume)}
                      disabled={busy}
                    >
                      {resume.is_primary ? 'Unset primary' : 'Make primary'}
                    </button>
                    <button
                      type="button"
                      className="btn small danger"
                      onClick={() => {
                        setActionError(null);
                        setConfirmDeleteId(resume.id);
                      }}
                      disabled={busy}
                    >
                      Delete
                    </button>
                  </div>
                )}

                {open?.kind === 'loading' && <p className="hint">Loading text…</p>}
                {open?.kind === 'error' && (
                  <p className="notice error">Couldn't load the text. {open.message}</p>
                )}
                {open?.kind === 'ready' &&
                  (open.text ? (
                    <pre className="resume-preview" tabIndex={0} aria-label="Extracted resume text">
                      {open.text}
                    </pre>
                  ) : (
                    <p className="hint">
                      No readable text was found. Scanned (image-only) resumes aren't supported yet.
                    </p>
                  ))}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
