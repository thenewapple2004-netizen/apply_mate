import type { CVData } from '../cv/api.ts';
import { CVEditor, Section, TextInput } from '../cv/CVEditor.tsx';

import { CONTACT_LABELS, type ContactField, type Section as CVSection } from './api.ts';

export type DetailField = ContactField | 'full_name';
export type DetailValues = Partial<Record<DetailField, string | null>>;

const LABELS: Record<DetailField, string> = { full_name: 'Full name', ...CONTACT_LABELS };
const TYPES: Partial<Record<DetailField, string>> = { email: 'email', phone: 'tel', linkedin_url: 'url' };

interface Props {
  /** Profile fields to show (onboarding shows only the missing ones). */
  fields: DetailField[];
  values: DetailValues;
  onValuesChange: (next: DetailValues) => void;
  /** CV sections to show (onboarding shows only unconfirmed/missing ones). */
  sections: CVSection[];
  cv: CVData;
  onCvChange: (next: CVData) => void;
  /** Errors keyed by field name ("email") or CV path ("work_experience.0.company"). */
  errors: Record<string, string>;
  disabled?: boolean;
}

/** The single form for profile + CV details, used for both onboarding review and editing. */
export function DetailsForm(props: Props) {
  const { fields, values, sections } = props;
  return (
    <div className="details-form">
      {fields.length > 0 && (
        <Section title="Contact details">
          {fields.map((field) => (
            <TextInput
              key={field}
              label={LABELS[field]}
              type={TYPES[field]}
              value={values[field] ?? null}
              onChange={(v) => props.onValuesChange({ ...values, [field]: v })}
              error={props.errors[field]}
              disabled={props.disabled}
              placeholder={field === 'linkedin_url' ? 'https://www.linkedin.com/in/…' : 'Not set'}
            />
          ))}
        </Section>
      )}
      {sections.length > 0 && (
        <CVEditor
          value={props.cv}
          onChange={props.onCvChange}
          errors={props.errors}
          sections={sections}
          disabled={props.disabled}
        />
      )}
    </div>
  );
}

/**
 * Splits FastAPI validation errors into form keys: "contact.email" -> "email",
 * "cv.work_experience.0.company" -> "work_experience.0.company".
 */
export function formErrors(fieldErrors: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, message] of Object.entries(fieldErrors)) {
    out[path.replace(/^(contact|cv)\./, '')] = message;
  }
  return out;
}
