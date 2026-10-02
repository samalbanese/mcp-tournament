import { describe, expect, it } from 'vitest';
import * as entry from '../../src/index.js';
import * as clients from '../../src/clients/index.js';

describe('embedding entry points', () => {
  it('exports the study runner, analysis, parser, batching, and reanalysis', () => {
    for (const name of ['runStudy', 'analyzeStudy', 'parseStudy', 'planBatches', 'reanalyzeStudy'] as const) {
      expect(typeof entry[name]).toBe('function');
    }
  });
  it('exports serve, createServer, and registerModelClient', () => {
    expect(typeof entry.serve).toBe('function');
    expect(typeof entry.createServer).toBe('function');
    expect(typeof clients.registerModelClient).toBe('function');
  });
});
