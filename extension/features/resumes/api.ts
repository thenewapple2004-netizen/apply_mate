import { createResume, deleteResume, getResume, listResumes, MAX_UPLOAD_BYTES, setPrimary } from '../../core/resumes.ts';
import { ctx } from '@/lib/runtime.ts';

export type { Resume, ResumeDetail } from '../../core/types.ts';
import type { Resume, ResumeDetail } from '../../core/types.ts';

export const MAX_RESUME_BYTES = MAX_UPLOAD_BYTES;
export const ACCEPTED_EXTENSIONS = ['pdf', 'docx'] as const;

/** Every call names the profile, and the resume must belong to it. */
export const resumesApi = {
  list: (profileId: string, _signal?: AbortSignal): Promise<Resume[]> => listResumes(ctx, profileId),

  get: (profileId: string, resumeId: string, _signal?: AbortSignal): Promise<ResumeDetail> =>
    getResume(ctx, profileId, resumeId),

  /** Reads the file's text here in the browser; the file itself is not kept. */
  upload: async (
    profileId: string,
    file: File,
    options: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
  ): Promise<Resume> => {
    options.signal?.throwIfAborted();
    const bytes = new Uint8Array(await file.arrayBuffer());
    options.onProgress?.(1);
    return createResume(ctx, profileId, file.name, bytes);
  },

  setPrimary: (profileId: string, resumeId: string, primary: boolean): Promise<Resume> =>
    setPrimary(ctx, profileId, resumeId, primary),

  remove: (profileId: string, resumeId: string): Promise<void> => deleteResume(ctx, profileId, resumeId),
};

/** Quick check so obvious mistakes fail instantly; the contents are validated when the file is read. */
export function checkFileBeforeUpload(file: File): string | null {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (!(ACCEPTED_EXTENSIONS as readonly string[]).includes(extension)) {
    return 'Only PDF and DOCX files are supported.';
  }
  if (file.size === 0) return 'The file is empty.';
  if (file.size > MAX_RESUME_BYTES) return 'The file is larger than the 10 MB limit.';
  return null;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
