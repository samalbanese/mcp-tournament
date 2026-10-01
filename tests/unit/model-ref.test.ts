import { afterEach, describe, expect, it } from 'vitest';
import { parseModelRef, ModelRefError } from '../../src/config/model-ref.js';
import {
  getModelClient, isRouteReady, registerModelClient, routeHasCredentials, routeSetupHint,
} from '../../src/clients/index.js';

const savedEnv = { ...process.env };
afterEach(() => { process.env = { ...savedEnv }; });

describe('parseModelRef', () => {
  it('keeps OpenRouter variant suffixes like :free as bare ids', () => {
    expect(parseModelRef('deepseek/deepseek-r1:free').route).toBe('openrouter');
  });

  it('routes a bare OpenRouter id to openrouter', () => {
    expect(parseModelRef('deepseek/deepseek-v3.2')).toEqual({
      ref: 'deepseek/deepseek-v3.2', route: 'openrouter', model: 'deepseek/deepseek-v3.2',
    });
  });
  it('strips an explicit openrouter: prefix to the canonical bare id', () => {
    expect(parseModelRef('openrouter:openai/gpt-5.4-mini')).toEqual({
      ref: 'openai/gpt-5.4-mini', route: 'openrouter', model: 'openai/gpt-5.4-mini',
    });
  });
  it('routes anthropic:claude-* to anthropic', () => {
    expect(parseModelRef('anthropic:claude-sonnet-5-5')).toEqual({
      ref: 'anthropic:claude-sonnet-5-5', route: 'anthropic', model: 'claude-sonnet-5-5',
    });
  });
  it('trims whitespace', () => {
    expect(parseModelRef('  anthropic:claude-haiku-4-5 ').model).toBe('claude-haiku-4-5');
  });
  it('rejects a non-Claude model on the anthropic route', () => {
    expect(() => parseModelRef('anthropic:gpt-5')).toThrow(ModelRefError);
    expect(() => parseModelRef('anthropic:gpt-5')).toThrow(/claude-/);
  });
  it('rejects chatgpt: as not set up yet', () => {
    expect(() => parseModelRef('chatgpt:gpt-5.4')).toThrow(/ChatGPT plan route is not set up yet/);
  });
  it('rejects unknown prefixes and empty refs in plain English', () => {
    expect(() => parseModelRef('gemini:pro')).toThrow(/Unknown provider prefix "gemini:"/);
    expect(() => parseModelRef('   ')).toThrow(/empty/);
    expect(() => parseModelRef('anthropic:')).toThrow(/empty/);
  });
});

describe('route readiness', () => {
  it('trusts a registered client that reports itself configured, without env keys', () => {
    delete process.env.ANTHROPIC_API_KEY;
    const original = getModelClient('anthropic');
    registerModelClient('anthropic', { isConfigured: () => true, createMessage: async () => { throw new Error('unused'); } });
    try {
      expect(routeHasCredentials('anthropic')).toBe(true);
    } finally {
      registerModelClient('anthropic', original);
    }
  });
  it('falls back to env keys for a registered client without isConfigured', () => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_DICE_ORACLE_API_KEY;
    const original = getModelClient('openrouter');
    registerModelClient('openrouter', { createMessage: async () => { throw new Error('unused'); } });
    try {
      expect(routeHasCredentials('openrouter')).toBe(false);
      process.env.OPENROUTER_DICE_ORACLE_API_KEY = 'x';
      expect(routeHasCredentials('openrouter')).toBe(true);
    } finally {
      registerModelClient('openrouter', original);
    }
  });
  it('reports anthropic credentials from ANTHROPIC_API_KEY only', () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(routeHasCredentials('anthropic')).toBe(false);
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    expect(routeHasCredentials('anthropic')).toBe(true);
  });
  it('treats chatgpt as never ready in this phase', () => {
    expect(routeHasCredentials('chatgpt')).toBe(false);
    expect(isRouteReady('chatgpt')).toBe(false);
  });
  it('treats a registered client without isConfigured as ready (test doubles)', () => {
    const original = getModelClient('openrouter');
    registerModelClient('openrouter', { createMessage: async () => { throw new Error('unused'); } });
    expect(isRouteReady('openrouter')).toBe(true);
    registerModelClient('openrouter', original);
  });
  it('setup hints name the env var and never echo a key', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-secret-value';
    expect(routeSetupHint('anthropic')).toContain('ANTHROPIC_API_KEY');
    expect(routeSetupHint('anthropic')).not.toContain('sk-secret-value');
    expect(routeSetupHint('openrouter')).toContain('OPENROUTER_API_KEY');
  });
});
