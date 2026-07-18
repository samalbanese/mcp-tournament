import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findUnknownModelId, isAllowedOrigin, mergeRunIndex } from '../../src/server.js';

const tempDirs: string[] = [];
afterEach(() => {
  for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('local GUI server', () => {
  it('merges newest result runs before unique seeded runs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-tournament-server-'));
    tempDirs.push(root);
    const results = path.join(root, 'results');
    const data = path.join(root, 'gui-data');
    fs.mkdirSync(path.join(results, 'run-2026-02'), { recursive: true });
    fs.mkdirSync(path.join(results, 'run-2026-03'), { recursive: true });
    fs.mkdirSync(path.join(results, 'not-a-run'), { recursive: true });
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(results, 'run-2026-02', 'run.json'), '{}');
    fs.writeFileSync(path.join(results, 'run-2026-03', 'run.json'), '{}');
    fs.writeFileSync(path.join(data, 'index.json'), JSON.stringify({ runs: ['run-seed', 'run-2026-02'] }));

    expect(mergeRunIndex(results, data)).toEqual({ runs: ['run-2026-03', 'run-2026-02', 'run-seed'] });
  });

  it('allows only loopback origins on the configured port', () => {
    expect(isAllowedOrigin(undefined, 4600)).toBe(true);
    expect(isAllowedOrigin('http://localhost:4600', 4600)).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:4600', 4600)).toBe(true);
    expect(isAllowedOrigin('http://[::1]:4600', 4600)).toBe(true);
    expect(isAllowedOrigin('https://example.com', 4600)).toBe(false);
    expect(isAllowedOrigin('http://localhost:9999', 4600)).toBe(false);
  });

  it('identifies the first requested model missing from the live catalog', () => {
    const requested = ['candidate/known', 'judge/missing', 'synthesizer/missing'];
    expect(findUnknownModelId(requested, ['candidate/known'])).toBe('judge/missing');
    expect(findUnknownModelId(requested, requested)).toBeUndefined();
  });
});
