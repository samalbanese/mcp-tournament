import { describe, expect, it } from 'vitest';
import * as entry from '../../src/index.js';
import * as clients from '../../src/clients/index.js';

describe('embedding entry points', () => {
  it('exports serve, createServer, and registerModelClient', () => {
    expect(typeof entry.serve).toBe('function');
    expect(typeof entry.createServer).toBe('function');
    expect(typeof clients.registerModelClient).toBe('function');
  });
});
