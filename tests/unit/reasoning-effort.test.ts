import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMessage, reasoningEffortFromEnv } from '../../src/clients/openrouter.js';
import type { CreateMessageParams } from '../../src/clients/types.js';

const { createCompletion } = vi.hoisted(() => ({ createCompletion: vi.fn() }));

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: createCompletion } };
  },
}));

const errorMessage = 'TOURNAMENT_REASONING_EFFORT must be one of minimal, low, medium, high';
const params: CreateMessageParams = {
  model: 'test/model',
  max_tokens: 100,
  system: 'Be concise.',
  messages: [{ role: 'user', content: 'Hello.' }],
};

beforeEach(() => {
  vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
  vi.stubEnv('TOURNAMENT_REASONING_EFFORT', undefined);
  createCompletion.mockReset();
  createCompletion.mockResolvedValue({
    model: 'test/model',
    choices: [{ message: { content: 'Hello.' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('reasoningEffortFromEnv', () => {
  it('returns undefined when unset', () => {
    expect(reasoningEffortFromEnv({})).toBeUndefined();
  });

  it.each(['minimal', 'low', 'medium', 'high'])('accepts %s', effort => {
    expect(reasoningEffortFromEnv({ TOURNAMENT_REASONING_EFFORT: effort })).toBe(effort);
  });

  it.each(['', '   '])('treats a blank value as unset (%j)', value => {
    expect(reasoningEffortFromEnv({ TOURNAMENT_REASONING_EFFORT: value })).toBeUndefined();
  });

  it('trims surrounding whitespace', () => {
    expect(reasoningEffortFromEnv({ TOURNAMENT_REASONING_EFFORT: ' low ' })).toBe('low');
  });

  it.each(['turbo', 'LOW'])('rejects invalid value %s', value => {
    expect(() => reasoningEffortFromEnv({ TOURNAMENT_REASONING_EFFORT: value }))
      .toThrow(new Error(errorMessage));
  });
});

describe('OpenRouter reasoning effort', () => {
  it('adds low reasoning effort to the request body', async () => {
    vi.stubEnv('TOURNAMENT_REASONING_EFFORT', 'low');

    await createMessage(params);

    expect(createCompletion).toHaveBeenCalledTimes(1);
    expect(createCompletion.mock.calls[0][0]).toEqual({
      model: 'test/model',
      max_tokens: 100,
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Hello.' },
      ],
      reasoning: { effort: 'low' },
    });
  });

  it('preserves the request body without a reasoning key when unset', async () => {
    await createMessage(params);

    const body = createCompletion.mock.calls[0][0];
    expect(body).not.toHaveProperty('reasoning');
    expect(body).toEqual({
      model: 'test/model',
      max_tokens: 100,
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Hello.' },
      ],
    });
  });

  it('reads the environment again on each call', async () => {
    vi.stubEnv('TOURNAMENT_REASONING_EFFORT', 'low');
    await createMessage(params);
    vi.stubEnv('TOURNAMENT_REASONING_EFFORT', 'high');
    await createMessage(params);
    vi.stubEnv('TOURNAMENT_REASONING_EFFORT', undefined);
    await createMessage(params);

    expect(createCompletion.mock.calls[0][0].reasoning).toEqual({ effort: 'low' });
    expect(createCompletion.mock.calls[1][0].reasoning).toEqual({ effort: 'high' });
    expect(createCompletion.mock.calls[2][0]).not.toHaveProperty('reasoning');
  });

  it('rejects invalid effort before sending a request', async () => {
    vi.stubEnv('TOURNAMENT_REASONING_EFFORT', 'turbo');

    await expect(createMessage(params)).rejects.toThrow(new Error(errorMessage));
    expect(createCompletion).not.toHaveBeenCalled();
  });
});
