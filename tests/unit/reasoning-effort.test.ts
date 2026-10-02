import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMessage } from '../../src/clients/openrouter.js';
import { REASONING_LEVELS } from '../../src/config/reasoning.js';
import type { CreateMessageParams } from '../../src/clients/types.js';

const { createCompletion } = vi.hoisted(() => ({ createCompletion: vi.fn() }));

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: createCompletion } };
  },
}));

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

describe('OpenRouter reasoning effort', () => {
  it.each(REASONING_LEVELS)('adds per-call %s reasoning effort to the request body', async reasoning => {
    await createMessage({ ...params, reasoning });

    expect(createCompletion).toHaveBeenCalledTimes(1);
    expect(createCompletion.mock.calls[0][0]).toEqual({
      model: 'test/model',
      max_tokens: 100,
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Hello.' },
      ],
      reasoning: { effort: reasoning },
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

  it('uses the level supplied on each call', async () => {
    await createMessage({ ...params, reasoning: 'low' });
    await createMessage({ ...params, reasoning: 'high' });
    await createMessage(params);

    expect(createCompletion.mock.calls[0][0].reasoning).toEqual({ effort: 'low' });
    expect(createCompletion.mock.calls[1][0].reasoning).toEqual({ effort: 'high' });
    expect(createCompletion.mock.calls[2][0]).not.toHaveProperty('reasoning');
  });

  it('ignores the removed environment setting', async () => {
    vi.stubEnv('TOURNAMENT_REASONING_EFFORT', 'turbo');
    await createMessage(params);
    expect(createCompletion.mock.calls[0][0]).not.toHaveProperty('reasoning');
  });
});
