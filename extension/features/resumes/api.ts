import { apiRequest, apiUpload } from '../../lib/api.ts';

export interface Resume {
  id: string;
  profile_id: string;
  original_filename: string;
  file_type: 'pdf' | 'docx';
  size_bytes: number;
  is_primary: boolean;
  text_length: number;
  has_text: boolean;
  created_at: string;
  updated_at: string;
}

export interface ResumeDetail extends Resume {
  extracted_text: string;
}

export const MAX_RESUME_BYTES = 10 * 1024 * 1024;
export const ACCEPTED_EXTENSIONS = ['pdf', 'docx'] as const;

const base = (profileId: string) =>
  `/api/v1/profiles/${encodeURIComponent(profileId)}/resumes`;
const one = (profileId: string, resumeId: string) =>
  `${base(profileId)}/${encodeURIComponent(resumeId)}`;

/** Every call names the profile, and the backend checks the resume belongs to it. */
export const resumesApi = {
  list: (profileId: string, signal?: AbortSignal) =>
    apiRequest<Resume[]>(base(profileId), { signal }),

  get: (profileId: string, resumeId: string, signal?: AbortSignal) =>
    apiRequest<ResumeDetail>(one(profileId, resumeId), { signal }),

  upload: (
    profileId: string,
    file: File,
    options: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
  ) => {
    const form = new FormData();
    form.append('file', file, file.name);
    return apiUpload<Resume>(base(profileId), form, options);
  },

  setPrimary: (profileId: string, resumeId: string, primary: boolean) =>
    apiRequest<Resume>(`${one(profileId, resumeId)}/primary`, {
      method: primary ? 'PUT' : 'DELETE',
    }),

  remove: (profileId: string, resumeId: string) =>
    apiRequest<void>(one(profileId, resumeId), { method: 'DELETE' }),
};

/** Quick client-side check so obvious mistakes fail instantly; the backend validates contents. */
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
