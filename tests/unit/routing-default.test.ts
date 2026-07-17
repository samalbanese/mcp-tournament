import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  JUDGES,
  PARTICIPANT_AGENT_MODEL,
  PARTICIPANT_AGENT_ROUTE,
  SYNTHESIZER,
} from '../../src/config/judges.js';

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(fullPath)
      : entry.name.endsWith('.ts') ? [fullPath] : [];
  });
}

describe('default model routing', () => {
  it('routes every model-backed role through OpenRouter', () => {
    expect(JUDGES.every(judge => judge.route === 'openrouter')).toBe(true);
    expect(SYNTHESIZER.route).toBe('openrouter');
    expect(PARTICIPANT_AGENT_ROUTE).toBe('openrouter');
    expect(PARTICIPANT_AGENT_MODEL).toBe('deepseek/deepseek-v3.2');
  });

  it('contains no direct paid-provider SDK or endpoint references', () => {
    const source = sourceFiles(path.resolve('src'))
      .map(file => fs.readFileSync(file, 'utf8')).join('\n');
    expect(source).not.toContain('@anthropic-ai/sdk');
    expect(source).not.toContain('api.anthropic.com');
  });
});
