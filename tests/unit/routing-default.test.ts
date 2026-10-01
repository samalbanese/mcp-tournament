import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  JUDGES, PARTICIPANT_AGENT_MODEL, PARTICIPANT_AGENT_ROUTE, SYNTHESIZER,
} from '../../src/config/judges.js';
import { parseModelRef } from '../../src/config/model-ref.js';

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(fullPath)
      : entry.name.endsWith('.ts') ? [fullPath] : [];
  });
}

describe('default model routing', () => {
  it('routes every model-backed role through OpenRouter by default', () => {
    expect(JUDGES.every(judge => judge.route === 'openrouter')).toBe(true);
    expect(SYNTHESIZER.route).toBe('openrouter');
    expect(PARTICIPANT_AGENT_ROUTE).toBe('openrouter');
    expect(PARTICIPANT_AGENT_MODEL).toBe('deepseek/deepseek-v3.2');
  });

  it('resolves any unprefixed model ref to OpenRouter', () => {
    for (const id of ['deepseek/deepseek-v3.2', 'anthropic/claude-sonnet-5.5', 'openai/gpt-5.4', 'deepseek/deepseek-r1:free']) {
      expect(parseModelRef(id).route).toBe('openrouter');
    }
  });

  it('imports the Anthropic SDK only from the dedicated client file', () => {
    const allowed = path.resolve('src', 'clients', 'anthropic.ts');
    const offenders = sourceFiles(path.resolve('src'))
      .filter(file => path.resolve(file) !== allowed)
      .filter(file => fs.readFileSync(file, 'utf8').includes('@anthropic-ai/sdk'));
    expect(offenders).toEqual([]);
  });

  it('never hardcodes the Anthropic API endpoint', () => {
    const source = sourceFiles(path.resolve('src')).map(file => fs.readFileSync(file, 'utf8')).join('\n');
    expect(source).not.toContain('api.anthropic.com');
  });
});
