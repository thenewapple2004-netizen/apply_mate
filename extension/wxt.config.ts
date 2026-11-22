import { defineConfig } from 'wxt';

// `npm run build:test` (JF_TEST=1) also lets the extension reach the local demo pages so
// the end-to-end tests can run. The release build never includes this.
const testBuild = process.env.JF_TEST === '1';

// See https://wxt.dev/api/reference/wxt/interfaces/inlineconfig.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  // WXT emits Manifest V3 for Chrome; pinned explicitly so it never changes silently.
  manifestVersion: 3,
  outDir: testBuild ? '.output-test' : '.output',
  manifest: {
    name: 'Job Fellow',
    description: 'AI-powered assistant for job applications.',
    action: {
      default_title: 'Job Fellow',
    },
    // Only Google's Gemini API, called directly with your own key. There is no Job Fellow server.
    host_permissions: [
      'https://generativelanguage.googleapis.com/*',
      ...(testBuild ? ['http://127.0.0.1:8080/*', 'http://localhost:8080/*'] : []),
    ],
    // storage: your profiles, resumes, answers and settings, kept on this computer.
    // activeTab + scripting: read and fill the page you're on, only when you open
    // Job Fellow on it. No access to all websites.
    permissions: ['storage', 'unlimitedStorage', 'activeTab', 'scripting'],
  },
});
