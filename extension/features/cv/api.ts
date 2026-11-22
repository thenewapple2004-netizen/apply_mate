import { analyzeResume, getAnalysis, getDetails, saveDetails } from '../../core/cv.ts';
import { ctx } from '@/lib/runtime.ts';

export type {
  Certification, CVAnalysis, CVData, CVDetails, Education, Project, WorkExperience,
} from '../../core/types.ts';
export { EMPTY_CV } from '../../core/types.ts';
import type { CVAnalysis, CVData, CVDetails } from '../../core/types.ts';

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

export const cvApi = {
  /** Sends the resume's text to Gemini with your own key. Only call after the user has consented. */
  analyze: (profileId: string, resumeId: string, _signal?: AbortSignal): Promise<CVAnalysis> =>
    analyzeResume(ctx, profileId, resumeId),

  getDraft: (profileId: string, resumeId: string, _signal?: AbortSignal): Promise<CVAnalysis> =>
    getAnalysis(ctx, profileId, resumeId),

  getDetails: (profileId: string, _signal?: AbortSignal): Promise<CVDetails> => getDetails(ctx, profileId),

  saveDetails: (profileId: string, data: CVData, sourceAnalysisId: string | null): Promise<CVDetails> =>
    saveDetails(ctx, profileId, { ...data, source_analysis_id: sourceAnalysisId }),
};
