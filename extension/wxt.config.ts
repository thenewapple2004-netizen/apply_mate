import { defineConfig } from 'wxt';

// See https://wxt.dev/api/reference/wxt/interfaces/inlineconfig.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  // WXT emits Manifest V3 for Chrome; pinned explicitly so it never changes silently.
  manifestVersion: 3,
  manifest: {
    name: 'Job Fellow',
    description: 'AI-powered assistant for job applications.',
    action: {
      default_title: 'Job Fellow',
    },
    // Only the local backend. Extension pages with host permissions can call it
    // without the backend enabling CORS.
    host_permissions: ['http://127.0.0.1:8000/*', 'http://localhost:8000/*'],
    // Remembers which profile is active (its ID only) between popup openings.
    permissions: ['storage'],
  },
});
