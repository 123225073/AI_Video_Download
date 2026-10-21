import { execFileSync } from 'node:child_process';
// Keep all packaging steps on the invoking Node runtime. Nested pnpm launchers
// can select a different runtime on Windows and fail to read local generated files.
for (const args of [
  ['scripts/prepare-collector.mjs'], ['scripts/prepare-cli.mjs'],
  ['scripts/verify-runtime.mjs'],
  ['node_modules/vite/bin/vite.js', 'build'],
  ['node_modules/electron-builder/cli.js', '--win', 'nsis', '--x64', '--publish', 'never', ...process.argv.slice(2)]
]) execFileSync(process.execPath, args, { stdio: 'inherit', windowsHide: true });
