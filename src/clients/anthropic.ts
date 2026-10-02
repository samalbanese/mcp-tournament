import Anthropic from '@anthropic-ai/sdk';
import { API_TIMEOUT_MS, RETRY_ATTEMPTS, RETRY_BASE_DELAY_MS } from '../config/constants.js';
import type { CreateMessageParams, ModelClient, ModelContentBlock, ModelResponse } from './types.js';

export interface AnthropicMessagesApi {
  create(body: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown>;
}

// Only locally authored errors are safe to expose without provider details.
class ClientError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function statusOf(error: unknown): number | undefined {
  if (error instanceof Anthropic.APIError) return error.status;
  return isRecord(error) && typeof error.status === 'number' ? error.status : undefined;
}

function isRetryable(error: unknown): boolean {
  const status = statusOf(error);
  if (status !== undefined) return status === 408 || status === 429 || status >= 500;
  if (error instanceof Anthropic.APIConnectionError || error instanceof Anthropic.APIUserAbortError) return true;
  return error instanceof Error && /abort|timeout|ECONNRESET|fetch failed/i.test(error.message);
}

function friendlyError(error: unknown, model: string): Error {
  if (error instanceof ClientError) return error;
  const status = statusOf(error);
  if (status === 404) return new Error(`Anthropic does not recognize the model "${model}". Check the ID (e.g. "claude-sonnet-5-5").`);
  if (status === 401 || status === 403) return new Error('Your ANTHROPIC_API_KEY was rejected. Check the key, or use the OpenRouter ID instead.');
  if (status !== undefined) return new Error(`Anthropic request failed (${status}). ${status >= 500 || status === 429 ? 'Try again later.' : 'Check the request and model settings.'}`);
  return new Error('Anthropic request failed. Check your connection and model settings, then try again.');
}

function isContentBlock(value: unknown): value is ModelContentBlock {
  return isRecord(value) && typeof value.type === 'string'
    && (value.text === undefined || typeof value.text === 'string')
    && (value.id === undefined || typeof value.id === 'string')
    && (value.name === undefined || typeof value.name === 'string');
}

function convertResponse(raw: unknown, model: string): ModelResponse {
  if (!isRecord(raw)) throw new ClientError('Anthropic returned an invalid message response.');
  if (raw.stop_reason === 'refusal') {
    const category = isRecord(raw.stop_details) ? raw.stop_details.category : undefined;
    const knownCategories = ['cyber', 'bio', 'frontier_llm', 'reasoning_extraction', 'general_harms'];
    throw new ClientError(typeof category === 'string' && knownCategories.includes(category)
      ? `Model declined (refusal: ${category})` : 'Model declined to answer (refusal)');
  }
  const content: unknown = raw.content ?? [];
  if (!Array.isArray(content) || !content.every(isContentBlock)) {
    throw new ClientError('Anthropic returned invalid message content.');
  }
  const usage = isRecord(raw.usage) ? raw.usage : {};
  return {
    text: content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n'),
    content: content.length ? content : [{ type: 'text', text: '' }],
    stop_reason: typeof raw.stop_reason === 'string' ? raw.stop_reason : 'end_turn',
    usage: {
      input_tokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
      output_tokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
    },
    model: typeof raw.model === 'string' ? raw.model : model,
  };
}

export function createAnthropicModelClient(
  getApi: () => AnthropicMessagesApi,
  opts: { retryDelayMs?: number } = {},
): ModelClient {
  const baseDelay = opts.retryDelayMs ?? RETRY_BASE_DELAY_MS;
  return {
    isConfigured: () => Boolean(process.env.ANTHROPIC_API_KEY),
    async createMessage(params: CreateMessageParams): Promise<ModelResponse> {
      const body: Record<string, unknown> = {
        model: params.model,
        max_tokens: params.max_tokens,
        // Tool-only turns can leave empty assistant text, which the API rejects.
        messages: params.messages.map(message =>
          message.role === 'assistant' && message.content === '' ? { ...message, content: '[no response]' } : message),
      };
      if (params.system) body.system = params.system;
      if (params.tools?.length) body.tools = params.tools;
      if (params.reasoning) body.output_config = { effort: params.reasoning };

      let lastError: unknown;
      for (let attempt = 0; attempt <= RETRY_ATTEMPTS; attempt++) {
        if (attempt > 0) await new Promise(resolve => setTimeout(resolve, baseDelay * 2 ** (attempt - 1)));
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
        try {
          const raw = await getApi().create(body, { signal: controller.signal });
          return convertResponse(raw, params.model);
        } catch (error) {
          lastError = error;
          if (error instanceof ClientError || !isRetryable(error) || attempt === RETRY_ATTEMPTS) {
            throw friendlyError(error, params.model);
          }
        } finally {
          clearTimeout(timer);
        }
      }
      throw friendlyError(lastError, params.model);
    },
  };
}

let sdk: Anthropic | null = null;

export const anthropicClient: ModelClient = createAnthropicModelClient(() => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new ClientError('Set ANTHROPIC_API_KEY to use anthropic: models, or use the OpenRouter ID.');
  if (!sdk || sdk.apiKey !== apiKey) {
    // Retries belong to this wrapper; disable SDK logs to keep provider details private.
    sdk = new Anthropic({ apiKey, maxRetries: 0, timeout: API_TIMEOUT_MS, logLevel: 'off' });
  }
  const client = sdk;
  return {
    create: (body, options) => {
      const { model, max_tokens, messages, ...rest } = body;
      if (typeof model !== 'string' || typeof max_tokens !== 'number' || !Array.isArray(messages)) {
        throw new ClientError('Anthropic requires a model, max_tokens, and messages.');
      }
      const request = { ...rest, model, max_tokens, messages };
      return client.messages.create(request as Anthropic.MessageCreateParamsNonStreaming, options);
    },
  };
});
