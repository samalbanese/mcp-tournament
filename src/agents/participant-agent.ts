/**
 * Generic participant-message adapter.
 * 
 * Generates messages through the active plugin's participant implementation.
 */

import type { TournamentPlugin, TestCase, Turn } from '../plugins/base.js';

let _activePlugin: TournamentPlugin | null = null;

export function setActivePlugin(plugin: TournamentPlugin): void {
  _activePlugin = plugin;
}

export async function generateParticipantMessage(
  scenario: TestCase,
  turns: Turn[],
  context?: Record<string, unknown>
): Promise<string> {
  if (!_activePlugin) {
    throw new Error('No active plugin set. Call setActivePlugin() first.');
  }
  return _activePlugin.generateParticipantMessage(scenario, turns, context);
}
