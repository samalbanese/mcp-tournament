// scenario-runner.ts — Orchestrates player agent + DM conversation for one model/scenario pair.
// Ported from v1 backend/scripts/oracle-tournament/scenario-runner.mjs

import { runConversation } from '../tools/conversation-loop.js';
import { generateParticipantMessage } from '../agents/participant-agent.js';
import { buildSystemPrompt } from '../prompts/system-prompt.js';
import { MAX_TURNS, MIN_TURNS } from '../config/constants.js';
import { modelSlug, scenarioSlug, type TestCase } from '../plugins/base.js';
import type { CandidateModel } from '../config/models.js';
import type { AnthropicMessage } from '../clients/openrouter.js';
import { log } from '../utils/logger.js';
import fs from 'node:fs';
import path from 'node:path';

export { modelSlug, scenarioSlug } from '../config/scenarios.js';

export interface ScenarioRunResult {
  success: boolean;
  turns: Array<{
    turn: number;
    type: 'setup' | 'player_turn';
    playerMessage: string;
    playerReflection?: string;
    dmResponse: string;
    dmMetrics: {
      ttfbMs: number | null;
      totalTimeMs: number;
      inputTokens: number;
      outputTokens: number;
      toolRounds: number;
      toolCallCount: number;
      narrativeLength: number;
    };
    playerMetrics?: {
      inputTokens: number;
      outputTokens: number;
      timeMs: number;
    };
    toolCalls: Array<{
      name: string;
      input: Record<string, unknown>;
      result: string;
      id: string;
      validation: { valid: boolean; errors: string[] };
      round: number;
    }>;
  }>;
  metrics: {
    dmInputTokens: number;
    dmOutputTokens: number;
    playerInputTokens: number;
    playerOutputTokens: number;
    totalTimeMs: number;
    toolCallCount: number;
    toolRounds: number;
  };
  toolCalls?: Array<{
    name: string;
    input: Record<string, unknown>;
    result: string;
    id: string;
    validation: { valid: boolean; errors: string[] };
    round: number;
  }>;
  error?: string;
}

/**
 * Run a single model through a single scenario.
 *
 * @param model - CandidateModel from config
 * @param scenario - Scenario object from config
 * @param outputDir - Path to save results
 * @returns ScenarioRunResult with success, turns, metrics, and optional error
 */
export async function runScenario(
  model: CandidateModel,
  scenario: Scenario,
  outputDir: string,
): Promise<ScenarioRunResult> {
  const slug = modelSlug(model.id);
  const scSlug = scenarioSlug(scenario);
  const scenarioDir = path.join(outputDir, 'candidates', slug, scSlug);
  fs.mkdirSync(scenarioDir, { recursive: true });

  const systemPrompt = buildSystemPrompt(scenario);

  log(`  [${model.name}/${scenario.name}] Starting...`);

  // Save the request config
  fs.writeFileSync(
    path.join(scenarioDir, 'request.json'),
    JSON.stringify(
      {
        model: model.id,
        scenario: scenario.id,
        systemPromptLength: systemPrompt.length,
        timestamp: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  const turns: ScenarioRunResult['turns'] = [];
  const allToolCalls: ScenarioRunResult['toolCalls'] = [];
  let conversationHistory: AnthropicMessage[] = [];
  const playerConversation: Array<{ role: 'dm' | 'player'; text: string }> = [];
  const totalMetrics: ScenarioRunResult['metrics'] = {
    dmInputTokens: 0,
    dmOutputTokens: 0,
    playerInputTokens: 0,
    playerOutputTokens: 0,
    totalTimeMs: 0,
    toolCallCount: 0,
    toolRounds: 0,
  };

  try {
    // Turn 0: Setup message is the first "player" message
    const setupMessage = scenario.setupMessage;

    const dmResult = await sendDMMessage(model.id, systemPrompt, conversationHistory, setupMessage);
    conversationHistory = dmResult.conversationHistory;
    allToolCalls!.push(...dmResult.toolCalls);

    totalMetrics.dmInputTokens += dmResult.metrics.inputTokens;
    totalMetrics.dmOutputTokens += dmResult.metrics.outputTokens;
    totalMetrics.toolCallCount += dmResult.metrics.toolCallCount;
    totalMetrics.toolRounds += dmResult.metrics.toolRounds;
    totalMetrics.totalTimeMs += dmResult.metrics.totalTimeMs;

    turns.push({
      turn: 0,
      type: 'setup',
      playerMessage: setupMessage,
      dmResponse: dmResult.narrativeText,
      dmMetrics: dmResult.metrics,
      toolCalls: dmResult.toolCalls,
    });

    playerConversation.push({ role: 'dm', text: dmResult.narrativeText });
    log(`  [${model.name}/${scenario.name}] Setup done (${dmResult.metrics.totalTimeMs}ms, ${dmResult.metrics.toolCallCount} tools)`);

    // Player agent turns
    for (let turn = 1; turn <= MAX_TURNS; turn++) {
      // Player agent generates a message
      const playerResult = await generatePlayerMessage(
        scenario.goalCard,
        playerConversation,
        turn,
        MAX_TURNS,
      );

      totalMetrics.playerInputTokens += playerResult.metrics.inputTokens;
      totalMetrics.playerOutputTokens += playerResult.metrics.outputTokens;

      log(`  [${model.name}/${scenario.name}] Turn ${turn}: "${playerResult.message.substring(0, 60)}..."`);

      // Send player message to DM
      const dmTurnResult = await sendDMMessage(
        model.id,
        systemPrompt,
        conversationHistory,
        playerResult.message,
      );
      conversationHistory = dmTurnResult.conversationHistory;
      allToolCalls!.push(...dmTurnResult.toolCalls);

      totalMetrics.dmInputTokens += dmTurnResult.metrics.inputTokens;
      totalMetrics.dmOutputTokens += dmTurnResult.metrics.outputTokens;
      totalMetrics.toolCallCount += dmTurnResult.metrics.toolCallCount;
      totalMetrics.toolRounds += dmTurnResult.metrics.toolRounds;
      totalMetrics.totalTimeMs += dmTurnResult.metrics.totalTimeMs + playerResult.metrics.timeMs;

      turns.push({
        turn,
        type: 'player_turn',
        playerMessage: playerResult.message,
        playerReflection: playerResult.reflection,
        dmResponse: dmTurnResult.narrativeText,
        dmMetrics: dmTurnResult.metrics,
        playerMetrics: playerResult.metrics,
        toolCalls: dmTurnResult.toolCalls,
      });

      playerConversation.push({ role: 'player', text: playerResult.message });
      playerConversation.push({ role: 'dm', text: dmTurnResult.narrativeText });

      log(`  [${model.name}/${scenario.name}]   DM responded (${dmTurnResult.metrics.totalTimeMs}ms, ${dmTurnResult.metrics.toolCallCount} tools)`);

      // Check if player agent wants to end early
      if (playerResult.shouldEnd && turn >= MIN_TURNS) {
        log(`  [${model.name}/${scenario.name}] Player agent ending after ${turn} turns (goals complete)`);
        break;
      }
    }

    // Save all results
    fs.writeFileSync(path.join(scenarioDir, 'turns.json'), JSON.stringify(turns, null, 2));
    fs.writeFileSync(path.join(scenarioDir, 'tool-calls.json'), JSON.stringify(allToolCalls, null, 2));
    fs.writeFileSync(path.join(scenarioDir, 'metrics.json'), JSON.stringify(totalMetrics, null, 2));

    // Human-readable response text
    let responseText = `# ${model.name} - ${scenario.name}\n\n`;
    for (const t of turns) {
      responseText += `## ${t.type === 'setup' ? 'Setup' : `Turn ${t.turn}`}\n\n`;
      responseText += `**Player:** ${t.playerMessage}\n\n`;
      responseText += `**DM:** ${t.dmResponse}\n\n`;
      if (t.toolCalls?.length) {
        responseText += `*Tools: ${t.toolCalls.map(tc => tc.name).join(', ')}*\n\n`;
      }
      responseText += '---\n\n';
    }
    fs.writeFileSync(path.join(scenarioDir, 'response-text.md'), responseText);

    log(`  [${model.name}/${scenario.name}] Complete: ${turns.length} turns, ${allToolCalls!.length} tool calls, ${totalMetrics.totalTimeMs}ms total`);

    return { success: true, turns, metrics: totalMetrics, toolCalls: allToolCalls };

  } catch (error) {
    const errorData = {
      error: (error as Error).message,
      stack: (error as Error).stack,
      timestamp: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(scenarioDir, 'error.json'), JSON.stringify(errorData, null, 2));
    log(`  [${model.name}/${scenario.name}] ERROR: ${(error as Error).message}`);
    return { success: false, turns, metrics: totalMetrics, error: (error as Error).message };
  }
}
