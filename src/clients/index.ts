import { openRouterClient } from './openrouter.js';
import type { ModelClient } from './types.js';

export type ClientRoute = 'openrouter';

const clients = new Map<string, ModelClient>([['openrouter', openRouterClient]]);

export function getModelClient(route: ClientRoute = 'openrouter'): ModelClient {
  const client = clients.get(route);
  if (!client) throw new Error(`No model client registered for route "${route}"`);
  return client;
}

export function registerModelClient(route: string, client: ModelClient): void {
  clients.set(route, client);
}
