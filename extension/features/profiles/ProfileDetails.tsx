import { openCVPage } from '../cv/api.ts';

import type { Profile } from './api.ts';

interface Props {
  profile: Profile;
  onEdit: () => void;
  onDelete: () => void;
}

export function ProfileDetails({ profile, onEdit, onDelete }: Props) {
  const rows: [string, React.ReactNode][] = [
    ['Email', profile.email],
    ['Phone', profile.phone],
    ['Location', profile.location],
    [
      'LinkedIn',
      profile.linkedin_url && (
        <a href={profile.linkedin_url} target="_blank" rel="noopener noreferrer">
          {profile.linkedin_url.replace(/^https?:\/\/(www\.)?/, '')}
        </a>
      ),
    ],
  ];

  return (
    <article className="profile-card" aria-label="Active profile">
      <p className="badge">Active profile</p>
      <h3>{profile.full_name}</h3>
      <dl>
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd className={value ? undefined : 'unset'}>{value || 'Not set'}</dd>
          </div>
        ))}
      </dl>
      <div className="actions">
        <button type="button" className="btn" onClick={onEdit}>
          Edit
        </button>
        <button type="button" className="btn" onClick={() => openCVPage(profile.id)}>
          CV details
        </button>
        <button type="button" className="btn danger" onClick={onDelete}>
          Delete
        </button>
      </div>
    </article>
  );
}
