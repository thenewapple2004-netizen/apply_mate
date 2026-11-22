// Builds the extension into .output-test with extra access to the local demo pages (for the
// end-to-end tests). The release build (`npm run build`) never includes that access.
import { spawnSync } from 'node:child_process';

const result = spawnSync('npx', ['wxt', 'build'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, JF_TEST: '1' },
});
process.exit(result.status ?? 1);
