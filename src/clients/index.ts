import { openRouterClient } from './openrouter.js';
import { anthropicClient } from './anthropic.js';
import type { ModelClient } from './types.js';

export type ClientRoute = 'openrouter' | 'anthropic' | 'chatgpt';

const clients = new Map<string, ModelClient>([
  ['openrouter', openRouterClient],
  ['anthropic', anthropicClient],
]);

export function getModelClient(route: ClientRoute = 'openrouter'): ModelClient {
  const client = clients.get(route);
  if (!client) throw new Error(`No model client registered for route "${route}". ${routeSetupHint(route)}`);
  return client;
}

export function registerModelClient(route: string, client: ModelClient): void {
  clients.set(route, client);
}

/** Env-only credential check. Plugins use it to decide between a live participant and canned lines. */
export function routeHasCredentials(route: ClientRoute): boolean {
  switch (route) {
    case 'openrouter': return Boolean(process.env.OPENROUTER_API_KEY ?? process.env.OPENROUTER_DICE_ORACLE_API_KEY);
    case 'anthropic': return Boolean(process.env.ANTHROPIC_API_KEY);
    case 'chatgpt': return false;
  }
}

/** True when a client is registered for the route and does not report missing credentials. */
export function isRouteReady(route: ClientRoute): boolean {
  if (route === 'chatgpt') return false;
  const client = clients.get(route);
  return Boolean(client) && (client?.isConfigured?.() ?? true);
}

export function routeSetupHint(route: ClientRoute): string {
  switch (route) {
    case 'openrouter': return 'Set OPENROUTER_API_KEY (get one at https://openrouter.ai) in your shell or MCP client config.';
    case 'anthropic': return 'Set ANTHROPIC_API_KEY to use anthropic: models, or use the OpenRouter ID (e.g. "anthropic/claude-sonnet-5.5").';
    case 'chatgpt': return 'The ChatGPT plan route is coming soon. Use the OpenRouter ID for OpenAI models for now.';
  }
}
