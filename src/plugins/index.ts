import type { TournamentPlugin } from './base.js';
import { codingPlugin } from './coding.js';
import { dndPlugin } from './dnd.js';

const plugins: Record<string, TournamentPlugin> = {
  dnd: dndPlugin,
  coding: codingPlugin,
};

export function registerPlugin(plugin: TournamentPlugin): void {
  if (plugins[plugin.name]) {
    throw new Error(`Plugin "${plugin.name}" is already registered`);
  }
  plugins[plugin.name] = plugin;
}

export function getPlugin(name = 'dnd'): TournamentPlugin {
  const plugin = plugins[name];
  if (!plugin) {
    throw new Error(`Unknown plugin "${name}". Available plugins: ${Object.keys(plugins).join(', ')}`);
  }
  return plugin;
}

export function listPlugins(): TournamentPlugin[] {
  return Object.values(plugins);
}
