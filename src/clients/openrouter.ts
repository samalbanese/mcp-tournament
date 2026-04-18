// openrouter.ts — Non-streaming OpenRouter API wrapper for tournament.
// Accepts Anthropic-style params, returns Anthropic-style responses.
// Uses the openai npm package pointed at OpenRouter's API.

import OpenAI from 'openai';
import { API_TIMEOUT_MS } from '../config/constants.js';

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | Array<{ type: string; [key: string]: unknown }>;
}

export interface AnthropicResponse {
  content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
  model: string;
  _raw?: { id: string; created: number; system_fingerprint: string | undefined };
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!_client) {
    const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.OPENROUTER_DICE_ORACLE_API_KEY;
    if (!apiKey) {
      throw new Error('OPENROUTER_API_KEY (or OPENROUTER_DICE_ORACLE_API_KEY) not set.');
    }
    _client = new OpenAI({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey,
      defaultHeaders: {
        'HTTP-Referer': 'https://diceoracle.com',
        'X-Title': 'Dice Oracle Tournament',
      },
      timeout: API_TIMEOUT_MS,
    });
  }
  return _client;
}

/**
 * Convert Anthropic tool definitions to OpenAI function format.
 */
function convertTools(
  anthropicTools: ToolDefinition[] | null | undefined
): OpenAI.Chat.ChatCompletionTool[] | undefined {
  if (!anthropicTools?.length) return undefined;
  return anthropicTools.map(tool => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      // Strip fields Gemini/some models choke on
      parameters: stripUnsupportedSchemaFields(tool.input_schema) as Record<string, unknown>,
    },
  }));
}

function stripUnsupportedSchemaFields(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return schema;
  const { minimum: _min, maximum: _max, default: _default, ...rest } = schema as Record<string, unknown>;
  if (rest['properties'] && typeof rest['properties'] === 'object') {
    rest['properties'] = Object.fromEntries(
      Object.entries(rest['properties'] as Record<string, unknown>).map(([k, v]) => [
        k,
        stripUnsupportedSchemaFields(v),
      ])
    );
  }
  if (rest['items']) {
    rest['items'] = stripUnsupportedSchemaFields(rest['items']);
  }
  return rest;
}

/**
 * Convert Anthropic messages (system + messages array) to OpenAI format.
 */
function convertMessages(
  system: string | undefined,
  messages: AnthropicMessage[]
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  if (system) out.push({ role: 'system', content: system });

  for (const msg of messages) {
    if (msg.role === 'user') {
      if (Array.isArray(msg.content)) {
        const content = msg.content as Array<{ type: string; [key: string]: unknown }>;
        const toolResults = content.filter(b => b['type'] === 'tool_result');
        const textBlocks = content.filter(b => b['type'] === 'text');
        for (const tr of toolResults) {
          out.push({
            role: 'tool',
            tool_call_id: tr['tool_use_id'] as string,
            content:
              typeof tr['content'] === 'string'
                ? tr['content']
                : JSON.stringify(tr['content']),
          });
        }
        if (textBlocks.length > 0) {
          out.push({
            role: 'user',
            content: textBlocks.map(b => b['text'] as string).join('\n'),
          });
        }
      } else {
        out.push({ role: 'user', content: msg.content as string });
      }
    } else if (msg.role === 'assistant') {
      if (Array.isArray(msg.content)) {
        const content = msg.content as Array<{ type: string; [key: string]: unknown }>;
        const textParts = content.filter(b => b['type'] === 'text');
        const toolUses = content.filter(b => b['type'] === 'tool_use');
        const assistantMsg: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
          role: 'assistant',
          content: textParts.map(b => b['text'] as string).join('\n') || null,
        };
        if (toolUses.length > 0) {
          assistantMsg.tool_calls = toolUses.map(tu => ({
            id: tu['id'] as string,
            type: 'function' as const,
            function: {
              name: tu['name'] as string,
              arguments: JSON.stringify(tu['input']),
            },
          }));
        }
        out.push(assistantMsg);
      } else {
        out.push({ role: 'assistant', content: msg.content as string });
      }
    }
  }
  return out;
}

/**
 * Convert OpenAI response to Anthropic message format.
 */
function convertResponse(openaiResponse: OpenAI.Chat.ChatCompletion): AnthropicResponse {
  const choice = openaiResponse.choices?.[0];
  if (!choice) {
    return {
      content: [{ type: 'text', text: '' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0 },
      model: openaiResponse.model || 'unknown',
    };
  }

  const message = choice.message;
  const content: AnthropicResponse['content'] = [];
  if (message.content) content.push({ type: 'text', text: message.content });
  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      let parsedArgs: unknown = {};
      try {
        parsedArgs = JSON.parse(tc.function.arguments);
      } catch {
        console.warn(
          `Failed to parse tool arguments for ${tc.function.name}: ${tc.function.arguments?.substring(0, 200)}`
        );
      }
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: parsedArgs,
      });
    }
  }

  let stop_reason = 'end_turn';
  if (choice.finish_reason === 'tool_calls') stop_reason = 'tool_use';
  else if (choice.finish_reason === 'length') stop_reason = 'max_tokens';

  return {
    content: content.length > 0 ? content : [{ type: 'text', text: '' }],
    stop_reason,
    usage: {
      input_tokens: openaiResponse.usage?.prompt_tokens ?? 0,
      output_tokens: openaiResponse.usage?.completion_tokens ?? 0,
    },
    model: openaiResponse.model,
  };
}

/**
 * Send a non-streaming message to any model via OpenRouter.
 * Accepts Anthropic-style params: { model, max_tokens, system, messages, tools }
 * Returns Anthropic-style response with content[], stop_reason, usage
 */
export async function createMessage(params: {
  model: string;
  max_tokens: number;
  system?: string;
  messages: AnthropicMessage[];
  tools?: ToolDefinition[] | null;
}): Promise<AnthropicResponse> {
  const { model, max_tokens, system, messages, tools } = params;
  const openaiMessages = convertMessages(system, messages);
  const openaiTools = convertTools(tools);

  const requestParams: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
    model,
    max_tokens,
    messages: openaiMessages,
  };
  if (openaiTools) requestParams.tools = openaiTools;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const response = await getClient().chat.completions.create(requestParams, {
      signal: controller.signal,
    });
    const converted = convertResponse(response);
    // Attach raw response metadata for logging
    converted._raw = {
      id: response.id,
      created: response.created,
      system_fingerprint: response.system_fingerprint,
    };
    return converted;
  } finally {
    clearTimeout(timer);
  }
}

interface OpenRouterModel {
  id: string;
  name: string;
  pricing: unknown;
  context_length: number;
  top_provider?: unknown;
}

/**
 * Verify a model exists on OpenRouter. Returns pricing info or null.
 */
let _modelsCache: OpenRouterModel[] | null = null;

export async function verifyModel(modelId: string): Promise<{
  id: string;
  name: string;
  pricing: unknown;
  context_length: number;
} | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY not set. Export it in your shell or .env.');
  }
  try {
    if (!_modelsCache) {
      const res = await fetch(`https://openrouter.ai/api/v1/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { data?: OpenRouterModel[] };
      _modelsCache = data.data ?? [];
    }
    const model = _modelsCache.find(m => m.id === modelId);
    if (!model) return null;
    return {
      id: model.id,
      name: model.name,
      pricing: model.pricing,
      context_length: model.context_length,
    };
  } catch {
    return null;
  }
}
