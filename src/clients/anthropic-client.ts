// anthropic-client.ts — Anthropic SDK wrapper for Claude calls via Max subscription.
// Returns same response format as openrouter.ts for interoperability.

import Anthropic from '@anthropic-ai/sdk';
import type { ZodType } from 'zod';
import { API_TIMEOUT_MS } from '../config/constants.js';

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set. Get one from platform.claude.com');
    _client = new Anthropic({ apiKey, timeout: API_TIMEOUT_MS });
  }
  return _client;
}

/**
 * Send a message to Claude via Anthropic API (Max subscription).
 * Returns same format as OpenRouter client for interoperability.
 */
export async function createClaudeMessage(params: {
  model: string;
  max_tokens: number;
  system?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string | Array<{ type: string; [key: string]: unknown }> }>;
}): Promise<{
  content: Array<{ type: string; text?: string }>;
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
  model: string;
}> {
  const response = await getClient().messages.create({
    model: params.model,
    max_tokens: params.max_tokens,
    ...(params.system ? { system: params.system } : {}),
    messages: params.messages as Anthropic.MessageParam[],
  });

  return {
    content: response.content.map(block => {
      if (block.type === 'text') return { type: 'text', text: block.text };
      return { type: block.type };
    }),
    stop_reason: response.stop_reason ?? 'end_turn',
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    },
    model: response.model,
  };
}

/**
 * Send a message to Claude and parse JSON response.
 * Validates against Zod schema.
 */
export async function createClaudeJsonMessage<T>(params: {
  model: string;
  max_tokens: number;
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  schema: ZodType<T>;
}): Promise<{ parsed: T | null; raw: string; usage: { input_tokens: number; output_tokens: number } }> {
  const response = await createClaudeMessage({
    model: params.model,
    max_tokens: params.max_tokens,
    system: params.system + '\n\nRespond ONLY with valid JSON. No markdown, no explanation.',
    messages: params.messages,
  });

  const text = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text ?? '')
    .join('\n');

  const jsonMatch = text.match(/```json\s*([\s\S]*?)```/) ?? text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { parsed: null, raw: text, usage: response.usage };
  }

  try {
    const rawJson = JSON.parse(jsonMatch[1] ?? jsonMatch[0]);
    const result = params.schema.safeParse(rawJson);
    return { parsed: result.success ? result.data : null, raw: text, usage: response.usage };
  } catch {
    return { parsed: null, raw: text, usage: response.usage };
  }
}
