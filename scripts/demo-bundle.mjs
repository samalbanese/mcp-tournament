import { cpSync, rmSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(scriptDir, '..');
const guiDir = path.join(repoDir, 'gui');
const sourceDir = path.join(guiDir, 'dist');
const targetDir = path.join(repoDir, 'demo-dist');

const build = spawnSync('npm run build', {
  cwd: guiDir,
  shell: true,
  stdio: 'inherit',
});

if (build.error) throw build.error;
if (build.status !== 0) {
  console.error(`GUI build failed with exit code ${build.status ?? 'unknown'}.`);
  process.exit(build.status ?? 1);
}

rmSync(targetDir, { recursive: true, force: true });
cpSync(sourceDir, targetDir, { recursive: true });

console.log(`Demo bundle ready: ${targetDir}`);
console.log('Deploy: npx wrangler pages deploy demo-dist --project-name mcp-tournament');
