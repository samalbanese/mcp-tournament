/**
 * Generalized system prompt builder — replaces oracle-tournament's system-prompt.ts.
 * 
 * Delegates to the active plugin for candidate system prompts.
 * Each plugin defines what role the candidate plays and how to behave.
 */

import type { TournamentPlugin, TestCase } from '../plugins/base.js';

let _activePlugin: TournamentPlugin | null = null;

export function setActivePlugin(plugin: TournamentPlugin): void {
  _activePlugin = plugin;
}

export function buildSystemPrompt(scenario: TestCase): string {
  if (!_activePlugin) {
    throw new Error('No active plugin set. Call setActivePlugin() first.');
  }
  return _activePlugin.buildCandidatePrompt(scenario);
}
