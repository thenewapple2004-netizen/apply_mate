import { type ChangeEvent, useEffect, useRef, useState } from 'react';

import { describeError } from '../../lib/api.ts';
import { checkFileBeforeUpload, resumesApi } from '../resumes/api.ts';

interface Props {
  profileId: string;
  /** Called after the file is stored and made the profile's primary resume. */
  onUploaded: () => void;
  onCancel?: () => void;
  title: string;
  hint: string;
}

const ACCEPT =
  '.pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export function ResumeUpload({ profileId, onUploaded, onCancel, title, hint }: Props) {
  const [progress, setProgress] = useState<{ name: string; value: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const lifetime = useRef(new AbortController());

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setError(null);
    const problem = checkFileBeforeUpload(file);
    if (problem) {
      setError(`${file.name}: ${problem}`);
      return;
    }
    const { signal } = lifetime.current;
    setProgress({ name: file.name, value: 0 });
    try {
      const resume = await resumesApi.upload(profileId, file, {
        signal,
        onProgress: (value) => setProgress({ name: file.name, value }),
      });
      // The uploaded resume becomes the one Job Fellow uses for this profile.
      await resumesApi.setPrimary(profileId, resume.id, true);
      if (!signal.aborted) onUploaded();
    } catch (err) {
      if (signal.aborted) return;
      setError(`${file.name}: ${describeError(err)}`);
      setProgress(null);
    }
  }

  return (
    <section className="step-card">
      <h3>{title}</h3>
      <p className="hint">{hint}</p>
      {progress ? (
        <div className="upload" role="status">
          <span className="upload-label">
            {progress.value < 1
              ? `Uploading ${progress.name}… ${Math.round(progress.value * 100)}%`
              : `Reading ${progress.name}…`}
          </span>
          <progress value={progress.value} max={1} />
        </div>
      ) : (
        <div className="actions">
          <button type="button" className="btn primary" onClick={() => input.current?.click()}>
            Choose PDF or DOCX
          </button>
          {onCancel && (
            <button type="button" className="btn" onClick={onCancel}>
              Cancel
            </button>
          )}
        </div>
      )}
      <input ref={input} type="file" accept={ACCEPT} onChange={(e) => void handleFile(e)} hidden aria-label="Choose a PDF or DOCX resume" />
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
