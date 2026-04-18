/**
 * Generalized conversation loop — replaces oracle-tournament's conversation-loop.ts.
 * 
 * Runs the candidate model through a test case, exchanging messages with the
 * participant agent. Domain plugins can provide tools for the candidate to use.
 */

import { createMessage as createORMessage } from '../clients/openrouter.js';
import type { TestCase, Turn, ToolDefinition } from '../plugins/base.js';
import { log } from '../utils/logger.js';
import { MAX_TURNS, MIN_TURNS } from '../config/constants.js';

export interface ConversationResult {
  success: boolean;
  turns: Turn[];
  error?: string;
}

export async function runConversation(
  model: string,
  systemPrompt: string,
  scenario: TestCase,
  participantFn: (scenario: TestCase, turns: Turn[]) => Promise<string>,
  tools?: ToolDefinition[]
): Promise<ConversationResult> {
  const turns: Turn[] = [];

  try {
    // Initial setup message (from the scenario)
    const setupTurn: Turn = {
      turn: 0,
      role: 'participant',
      content: scenario.setupMessage,
    };
    turns.push(setupTurn);

    for (let i = 0; i < scenario.maxTurns; i++) {
      // Candidate responds
      const messages = [
        { role: 'system' as const, content: systemPrompt },
        ...turns.map(t => ({
          role: t.role === 'candidate' ? 'assistant' as const : 'user' as const,
          content: t.content,
        })),
      ];

      const startTime = Date.now();
      const response = await createORMessage({
        model,
        messages,
        max_tokens: 2048,
      });
      const totalTimeMs = Date.now() - startTime;

      const candidateTurn: Turn = {
        turn: i + 1,
        role: 'candidate',
        content: response.text,
        metrics: {
          ttfbMs: null,
          totalTimeMs,
          inputTokens: response.usage?.input_tokens || 0,
          outputTokens: response.usage?.output_tokens || 0,
        },
      };
      turns.push(candidateTurn);

      log(`Turn ${i + 1}: ${model} responded (${totalTimeMs}ms, ${response.usage?.output_tokens || 0} tokens)`);

      // Participant responds (unless we've hit min turns and candidate signals completion)
      if (i < scenario.maxTurns - 1) {
        const participantMessage = await participantFn(scenario, turns);
        turns.push({
          turn: i + 1,
          role: 'participant',
          content: participantMessage,
        });
      }
    }

    return { success: true, turns };
  } catch (error) {
    return {
      success: false,
      turns,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
