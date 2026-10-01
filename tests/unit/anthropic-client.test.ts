import { afterEach, describe, expect, it, vi } from 'vitest';
import { anthropicClient, createAnthropicModelClient, type AnthropicMessagesApi } from '../../src/clients/anthropic.js';
import { API_TIMEOUT_MS, RETRY_ATTEMPTS } from '../../src/config/constants.js';

const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function api(responses: Array<unknown | Error>): AnthropicMessagesApi & { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    create: vi.fn(async (body: Record<string, unknown>) => {
      calls.push(body);
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    }),
  };
}

const ok = (content: unknown[], stop_reason = 'end_turn') => ({
  id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5',
  content, stop_reason, usage: { input_tokens: 11, output_tokens: 7 },
});

function statusError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

describe('anthropic client', () => {
  it('maps the request near-identically and sends no fallbacks, thinking, or sampling params', async () => {
    const fake = api([ok([{ type: 'text', text: 'hi' }])]);
    const client = createAnthropicModelClient(() => fake, { retryDelayMs: 0 });
    await client.createMessage({
      model: 'claude-sonnet-5-5', system: 'sys', max_tokens: 100,
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ name: 'roll', description: 'roll dice', input_schema: { type: 'object', properties: {} } }],
    });
    const body = fake.calls[0];
    expect(body).toMatchObject({ model: 'claude-sonnet-5-5', system: 'sys', max_tokens: 100 });
    expect(body.tools).toEqual([{ name: 'roll', description: 'roll dice', input_schema: { type: 'object', properties: {} } }]);
    for (const banned of ['fallbacks', 'thinking', 'temperature', 'top_p', 'top_k']) {
      expect(body).not.toHaveProperty(banned);
    }
  });

  it('keeps thinking blocks in content and excludes them from text', async () => {
    const fake = api([ok([
      { type: 'thinking', thinking: 'secret plan', signature: 'sig' },
      { type: 'text', text: 'Answer.' },
      { type: 'tool_use', id: 'tu_1', name: 'roll', input: { sides: 20 } },
    ], 'tool_use')]);
    const response = await createAnthropicModelClient(() => fake, { retryDelayMs: 0 })
      .createMessage({ model: 'claude-opus-5-5', max_tokens: 50, messages: [{ role: 'user', content: 'go' }] });
    expect(response.text).toBe('Answer.');
    expect(response.content.map(block => block.type)).toEqual(['thinking', 'text', 'tool_use']);
    expect(response.content[0]).toMatchObject({ thinking: 'secret plan', signature: 'sig' });
    expect(response.stop_reason).toBe('tool_use');
    expect(response.usage).toEqual({ input_tokens: 11, output_tokens: 7 });
  });

  it('throws on a refusal so the pair is recorded as a failure', async () => {
    const fake = api([ok([], 'refusal')]);
    await expect(createAnthropicModelClient(() => fake, { retryDelayMs: 0 })
      .createMessage({ model: 'claude-sonnet-5-5', max_tokens: 50, messages: [{ role: 'user', content: 'x' }] }))
      .rejects.toThrow(/Model declined to answer \(refusal\)/);
  });

  it('retries 429 and 5xx, then succeeds', async () => {
    const fake = api([statusError(429, 'rate'), statusError(529, 'overloaded'), ok([{ type: 'text', text: 'ok' }])]);
    const response = await createAnthropicModelClient(() => fake, { retryDelayMs: 0 })
      .createMessage({ model: 'claude-haiku-4-5', max_tokens: 5, messages: [{ role: 'user', content: 'x' }] });
    expect(response.text).toBe('ok');
    expect(fake.calls).toHaveLength(3);
  });

  it('fails fast on 404 with a message naming the model', async () => {
    const fake = api([statusError(404, 'not_found_error: model: claude-sonet-5-5')]);
    await expect(createAnthropicModelClient(() => fake, { retryDelayMs: 0 })
      .createMessage({ model: 'claude-sonet-5-5', max_tokens: 5, messages: [{ role: 'user', content: 'x' }] }))
      .rejects.toThrow(/Anthropic does not recognize the model "claude-sonet-5-5"/);
    expect(fake.calls).toHaveLength(1);
  });

  it('fails fast on 401 without echoing the key', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-should-not-leak';
    const fake = api([statusError(401, 'invalid x-api-key')]);
    const error = await createAnthropicModelClient(() => fake, { retryDelayMs: 0 })
      .createMessage({ model: 'claude-haiku-4-5', max_tokens: 5, messages: [{ role: 'user', content: 'x' }] })
      .catch((caught: Error) => caught);
    expect(String(error)).toMatch(/ANTHROPIC_API_KEY was rejected/);
    expect(String(error)).not.toContain('sk-ant-should-not-leak');
    expect(fake.calls).toHaveLength(1);
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('replaces an empty assistant string so the API does not reject the history', async () => {
    const fake = api([ok([{ type: 'text', text: 'ok' }])]);
    await createAnthropicModelClient(() => fake, { retryDelayMs: 0 }).createMessage({
      model: 'claude-haiku-4-5', max_tokens: 5,
      messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: '' }, { role: 'user', content: 'b' }],
    });
    const sent = fake.calls[0].messages as Array<{ content: unknown }>;
    expect(sent[1].content).toBe('[no response]');
  });

  it('fails fast on 400 and never returns raw provider error text', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-private-xxxx';
    const fake = api([statusError(400, 'bad request: sk-ant-private-xxxx (sk-ant-private)')]);
    const error = await createAnthropicModelClient(() => fake, { retryDelayMs: 0 })
      .createMessage({ model: 'claude-haiku-4-5', max_tokens: 5, messages: [] })
      .catch((caught: Error) => caught);
    expect(String(error)).toMatch(/400/);
    expect(String(error)).not.toContain('sk-ant-private');
    expect(fake.calls).toHaveLength(1);
  });

  it('stops after the configured retry limit without returning provider details', async () => {
    const fake = api(Array.from({ length: RETRY_ATTEMPTS + 1 }, () => statusError(503, 'sk-ant-private-xxxx')));
    const error = await createAnthropicModelClient(() => fake, { retryDelayMs: 0 })
      .createMessage({ model: 'claude-haiku-4-5', max_tokens: 5, messages: [] })
      .catch((caught: Error) => caught);
    expect(String(error)).toMatch(/503/);
    expect(String(error)).not.toContain('sk-ant-private');
    expect(fake.calls).toHaveLength(RETRY_ATTEMPTS + 1);
  });

  it('passes tool history and thinking signatures back unchanged', async () => {
    const blocks = [
      { type: 'thinking', thinking: 'plan', signature: 'sig' },
      { type: 'tool_use', id: 'tu_1', name: 'roll', input: { sides: 20 } },
    ];
    const messages = [
      { role: 'assistant' as const, content: blocks },
      { role: 'user' as const, content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '12' }] },
    ];
    const fake = api([ok([{ type: 'text', text: 'ok' }])]);
    await createAnthropicModelClient(() => fake).createMessage({ model: 'claude-haiku-4-5', max_tokens: 5, messages });
    expect(fake.calls[0].messages).toEqual(messages);
    expect(fake.calls[0]).not.toHaveProperty('tools');
  });

  it('reports the refusal category when the API supplies one, without retrying', async () => {
    const fake = api([{ ...ok([], 'refusal'), stop_details: { category: 'general_harms' } }]);
    await expect(createAnthropicModelClient(() => fake).createMessage({
      model: 'claude-haiku-4-5', max_tokens: 5, messages: [],
    })).rejects.toThrow(/Model declined \(refusal: general_harms\)/);
    expect(fake.calls).toHaveLength(1);
  });

  it('passes an abort signal and retries timed-out attempts within the retry limit', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const fake: AnthropicMessagesApi = {
      create: (_body, options) => new Promise((_resolve, reject) => {
        const signal = options?.signal;
        if (!signal) throw new Error('Missing signal');
        signals.push(signal);
        signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
      }),
    };
    const result = createAnthropicModelClient(() => fake, { retryDelayMs: 0 })
      .createMessage({ model: 'claude-haiku-4-5', max_tokens: 5, messages: [] })
      .catch((caught: Error) => caught);
    await vi.advanceTimersByTimeAsync(API_TIMEOUT_MS * (RETRY_ATTEMPTS + 1) + 10);
    expect(String(await result)).toMatch(/timed out|connection/i);
    expect(signals).toHaveLength(RETRY_ATTEMPTS + 1);
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports the missing key before trying to make an SDK request', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(anthropicClient.isConfigured?.()).toBe(false);
    await expect(anthropicClient.createMessage({ model: 'claude-haiku-4-5', max_tokens: 5, messages: [] }))
      .rejects.toThrow(/Set ANTHROPIC_API_KEY/);
  });

  it('uses the installed SDK with current credentials and safe typed API errors', async () => {
    const requests: Request[] = [];
    const responses = [
      Response.json(ok([{ type: 'text', text: 'SDK response' }]), { status: 200 }),
      Response.json(ok([{ type: 'text', text: 'rotated' }]), { status: 200 }),
      Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'sk-ant-sdk-second' } }, { status: 400 }),
    ];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      requests.push(new Request(input, init));
      const response = responses.shift();
      if (!response) throw new Error('Unexpected extra SDK attempt');
      return response;
    });
    vi.stubGlobal('fetch', fetcher);
    process.env.ANTHROPIC_BASE_URL = 'https://anthropic.test';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-sdk-first';
    const params = {
      model: 'claude-haiku-4-5', system: 'system prompt', max_tokens: 10,
      messages: [{ role: 'user' as const, content: 'hello' }],
    };
    expect((await anthropicClient.createMessage(params)).text).toBe('SDK response');
    expect(await requests[0].json()).toEqual(params);
    expect(requests[0].headers.get('x-api-key')).toBe('sk-ant-sdk-first');
    process.env.ANTHROPIC_API_KEY = 'sk-ant-sdk-second';
    expect((await anthropicClient.createMessage(params)).text).toBe('rotated');
    expect(requests[1].headers.get('x-api-key')).toBe('sk-ant-sdk-second');
    const error = await anthropicClient.createMessage(params).catch((caught: Error) => caught);
    expect(String(error)).toContain('400');
    expect(String(error)).not.toContain('sk-ant-sdk');
    expect(fetcher).toHaveBeenCalledTimes(3);
    delete process.env.ANTHROPIC_API_KEY;
    await expect(anthropicClient.createMessage(params)).rejects.toThrow(/Set ANTHROPIC_API_KEY/);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
