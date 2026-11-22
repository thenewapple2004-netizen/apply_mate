import React from 'react';
import ReactDOM from 'react-dom/client';

import { CVPage } from '@/features/cv/CVPage.tsx';

import '../popup/style.css';
import './cv.css';

const params = new URLSearchParams(location.search);
const profileId = params.get('profile');
const resumeId = params.get('resume');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {profileId ? (
      <CVPage profileId={profileId} resumeId={resumeId} />
    ) : (
      <main className="cv-page">
        <p className="notice error">No profile selected. Open this page from the ApplyMate popup.</p>
      </main>
    )}
  </React.StrictMode>,
);
