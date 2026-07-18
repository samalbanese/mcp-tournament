import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const stage = path.join(root, '.vite-src');
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
const html = (await readFile(path.join(root, 'index.html'), 'utf8')).replace('/src/main.tsx', '/main.js');
await writeFile(path.join(stage, 'index.html'), html);
await cp(path.join(root, 'src', 'styles.css'), path.join(stage, 'styles.css'));