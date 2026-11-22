import { apiRequest } from '../../lib/api.ts';

export interface WorkExperience {
  company: string | null;
  title: string | null;
  location: string | null;
  start_date: string | null;
  end_date: string | null;
  is_current: boolean | null;
  responsibilities: string[];
}

export interface Education {
  institution: string | null;
  degree: string | null;
  field_of_study: string | null;
  start_date: string | null;
  end_date: string | null;
  details: string[];
}

export interface Project {
  name: string | null;
  role: string | null;
  description: string | null;
  technologies: string[];
  url: string | null;
}

export interface Certification {
  name: string | null;
  issuer: string | null;
  date: string | null;
}

export interface CVData {
  summary: string | null;
  skills: string[];
  technologies: string[];
  work_experience: WorkExperience[];
  education: Education[];
  projects: Project[];
  certifications: Certification[];
}

export interface CVAnalysis {
  id: string;
  profile_id: string;
  resume_id: string;
  status: 'draft' | 'confirmed';
  provider: string;
  model: string;
  data: CVData;
  warnings: string[];
  analyzed_at: string;
  confirmed_at: string | null;
}

export interface CVDetails extends CVData {
  profile_id: string;
  source_resume_id: string | null;
  source_analysis_id: string | null;
  confirmed_at: string;
  updated_at: string;
}

export const EMPTY_CV: CVData = {
  summary: null,
  skills: [],
  technologies: [],
  work_experience: [],
  education: [],
  projects: [],
  certifications: [],
};

/** Just the editable CV fields (drops ids and timestamps from a saved record). */
export function toCVData(source: CVData): CVData {
  return {
    summary: source.summary,
    skills: source.skills,
    technologies: source.technologies,
    work_experience: source.work_experience,
    education: source.education,
    projects: source.projects,
    certifications: source.certifications,
  };
}

const profileBase =(profileId: string) => `/api/v1/profiles/${encodeURIComponent(profileId)}`;
const analysisUrl = (profileId: string, resumeId: string) =>
  `${profileBase(profileId)}/resumes/${encodeURIComponent(resumeId)}/analysis`;

/** AI analysis can take a while; allow up to three minutes. */
const ANALYSIS_TIMEOUT_MS = 180_000;

export const cvApi = {
  /** Sends the resume's text to Gemini. Only call after the user has consented. */
  analyze: (profileId: string, resumeId: string, signal?: AbortSignal) =>
    apiRequest<CVAnalysis>(analysisUrl(profileId, resumeId), {
      method: 'POST',
      body: { consent: true },
      signal,
      timeoutMs: ANALYSIS_TIMEOUT_MS,
    }),

  getDraft: (profileId: string, resumeId: string, signal?: AbortSignal) =>
    apiRequest<CVAnalysis>(analysisUrl(profileId, resumeId), { signal }),

  getDetails: (profileId: string, signal?: AbortSignal) =>
    apiRequest<CVDetails>(`${profileBase(profileId)}/cv`, { signal }),

  saveDetails: (profileId: string, data: CVData, sourceAnalysisId: string | null) =>
    apiRequest<CVDetails>(`${profileBase(profileId)}/cv`, {
      method: 'PUT',
      body: { ...data, source_analysis_id: sourceAnalysisId },
    }),
};

/** Opens the full CV page in a new tab (the popup is too small for reviewing a CV). */
export function openCVPage(profileId: string, resumeId?: string) {
  const params = new URLSearchParams({ profile: profileId });
  if (resumeId) params.set('resume', resumeId);
  void browser.tabs.create({ url: browser.runtime.getURL(`/cv.html?${params}`) });
}
