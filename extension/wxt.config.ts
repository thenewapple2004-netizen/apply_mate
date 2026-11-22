import { defineConfig } from 'wxt';

// See https://wxt.dev/api/reference/wxt/interfaces/inlineconfig.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  // WXT emits Manifest V3 for Chrome; pinned explicitly so it never changes silently.
  manifestVersion: 3,
  manifest: {
    name: 'ApplyMate',
    description: 'AI-powered assistant for job applications.',
    action: {
      default_title: 'ApplyMate',
    },
  },
});
