/** Domain types shared by core/ and the UI (the feature api.ts files re-export them). */

// ---- profiles ----
export interface Profile {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  location: string | null;
  linkedin_url: string | null;
  created_at: string;
  updated_at: string;
}
/** The editable fields. Empty strings are stored as null. */
export type ProfileInput = Pick<Profile, 'full_name' | 'email' | 'phone' | 'location' | 'linkedin_url'>;

// ---- resumes ----
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
/** As stored: the file itself is not kept, only its text and details. */
export interface StoredResume {
  id: string;
  profile_id: string;
  original_filename: string;
  file_type: 'pdf' | 'docx';
  size_bytes: number;
  sha256: string;
  extracted_text: string;
  is_primary: boolean;
  created_at: string;
  updated_at: string;
}

// ---- CV details ----
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
export const EMPTY_CV: CVData = {
  summary: null,
  skills: [],
  technologies: [],
  work_experience: [],
  education: [],
  projects: [],
  certifications: [],
};
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
export interface StoredAnalysis extends CVAnalysis {
  /** Suggested contact details (email, phone, location, linkedin_url), already validated. */
  contact: Partial<Record<ContactField, string>>;
}
export interface CVDetails extends CVData {
  profile_id: string;
  source_resume_id: string | null;
  source_analysis_id: string | null;
  confirmed_at: string;
  updated_at: string;
}

// ---- onboarding ----
export type ContactField = 'email' | 'phone' | 'location' | 'linkedin_url';
export type Section = keyof CVData;
export interface ReviewForm {
  contact_fields: ContactField[];
  contact: Partial<Record<ContactField, string | null>>;
  sections: Section[];
  cv: CVData;
  source_analysis_id: string | null;
  warnings: string[];
}
export interface OnboardingState {
  step: 'resume' | 'review' | 'complete';
  profile: Profile;
  resume: Resume | null;
  resume_count: number;
  cv: CVData | null;
  analysis: { id: string; status: 'draft' | 'confirmed'; model: string; analyzed_at: string } | null;
  review: ReviewForm | null;
}
export interface ReviewSubmission {
  contact: Partial<Record<ContactField, string>>;
  cv: CVData;
  source_analysis_id: string | null;
}

// ---- preferences ----
export type Arrangement = 'remote' | 'hybrid' | 'onsite';
export interface Preferences {
  salary_expectation: string | null;
  notice_period: string | null;
  preferred_locations: string[];
  work_arrangements: Arrangement[];
  work_authorization_countries: string[];
  requires_sponsorship: boolean | null;
  change_reason: string | null;
  career_goals: string | null;
}
export const EMPTY_PREFERENCES: Preferences = {
  salary_expectation: null,
  notice_period: null,
  preferred_locations: [],
  work_arrangements: [],
  work_authorization_countries: [],
  requires_sponsorship: null,
  change_reason: null,
  career_goals: null,
};
export interface StoredPreferences extends Preferences {
  updated_at: string;
}

// ---- answering application forms ----
export type FieldKind =
  | 'text' | 'email' | 'tel' | 'url' | 'number' | 'date' | 'textarea' | 'select' | 'radio' | 'checkbox';
export interface FormField {
  id: string;
  label: string;
  type: FieldKind;
  required: boolean;
  options: { value: string; label: string }[];
}
export interface JobInfo {
  title: string;
  company: string;
  description: string;
  url: string;
}
export type AnswerSource = 'profile' | 'preference' | 'cv' | 'saved' | 'ai' | 'user' | 'none';
export interface Suggestion {
  label: string;
  answer: string | null;
}
export interface PreparedAnswer {
  field_id: string;
  value: string | null;
  values: string[];
  source: AnswerSource;
  note: string | null;
  suggestions?: Suggestion[];
  cached?: boolean;
  needs_approval?: boolean;
  approved?: boolean;
  preference?: string | null;
}
export interface PrepareResponse {
  answers: PreparedAnswer[];
  ai_used: boolean;
  ai_error: string | null;
  cache_hits: number;
  context_version: string;
}

// ---- applied jobs ----
export interface JobApplication {
  id: string;
  title: string;
  company: string;
  url: string;
  applied_at: string;
  already_recorded: boolean;
}
export interface StoredApplication {
  id: string;
  job_key: string;
  title: string;
  company: string;
  url: string;
  applied_at: string;
}
export interface ApplicationStats {
  total: number;
  today: number;
  last_7_days: number;
  last_30_days: number;
}

// ---- saved answers ----
export interface SavedAnswer {
  question_key: string;
  question: string;
  answer: string;
  created_at: string;
  updated_at: string;
}
