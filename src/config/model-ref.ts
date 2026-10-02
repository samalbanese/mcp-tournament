import type { ClientRoute } from '../clients/index.js';
import { ModelRefError } from './model-ref-error.js';
import { ANTHROPIC_LEVELS, splitReasoning, type ReasoningLevel } from './reasoning.js';

export { ModelRefError } from './model-ref-error.js';

export interface ParsedModelRef {
  /** Canonical ref, including any @level suffix. Used as the result id. */
  ref: string;
  route: ClientRoute;
  /** The model name sent to the provider API. */
  model: string;
  reasoning?: ReasoningLevel;
  /** Set by applyReasoningCatalog; undefined until then. */
  thinks?: boolean;
}

const PREFIX = /^([a-z][a-z0-9-]*):(.*)$/i;

export function parseModelRef(input: string): ParsedModelRef {
  const { base, reasoning } = splitReasoning(input.trim());
  const result = parseBaseRef(base);
  if (!reasoning) return result;
  if (result.route === 'anthropic' && !(ANTHROPIC_LEVELS as readonly ReasoningLevel[]).includes(reasoning)) {
    throw new ModelRefError(`"${input.trim()}": the Anthropic API accepts ${ANTHROPIC_LEVELS.join(', ')}.`);
  }
  return { ...result, ref: `${result.ref}@${reasoning}`, reasoning };
}

function parseBaseRef(input: string): ParsedModelRef {
  const raw = input.trim();
  if (!raw) throw new ModelRefError('Model ID is empty. Use an OpenRouter ID like "deepseek/deepseek-v3.2".');
  const match = raw.match(PREFIX);
  // The prefix cannot contain "/", so OpenRouter IDs like "deepseek/deepseek-r1:free" never match.
  if (!match) return { ref: raw, route: 'openrouter', model: raw };
  const prefix = match[1].toLowerCase();
  const model = match[2].trim();
  if (!model) throw new ModelRefError(`Model ID after "${prefix}:" is empty.`);
  switch (prefix) {
    case 'openrouter':
      return { ref: model, route: 'openrouter', model };
    case 'anthropic':
      if (!model.startsWith('claude-')) {
        throw new ModelRefError(
          `"${raw}" is not an Anthropic model. The anthropic: prefix only takes Claude model IDs ` +
          'like "anthropic:claude-sonnet-5-5"; use the OpenRouter ID for other models.',
        );
      }
      return { ref: `anthropic:${model}`, route: 'anthropic', model };
    case 'chatgpt':
      throw new ModelRefError(
        'ChatGPT plan route is not set up yet. Use the OpenRouter ID instead, e.g. "openai/gpt-5.4-mini".',
      );
    default:
      throw new ModelRefError(
        `Unknown provider prefix "${prefix}:". Use a bare OpenRouter ID, "openrouter:<id>", or "anthropic:claude-<model>".`,
      );
  }
}
