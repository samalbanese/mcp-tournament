import fs from 'node:fs';
import path from 'node:path';
import { getModelClient } from '../clients/index.js';
import type { ModelMessage, ModelToolDefinition } from '../clients/types.js';
import { MAX_TOKENS_CANDIDATE, MAX_TOOL_ROUNDS } from '../config/constants.js';
import type { CandidateModel } from '../config/models.js';
import {
  modelSlug,
  scenarioSlug,
  type TestCase,
  type ToolCall,
  type TournamentPlugin,
  type Turn,
} from '../plugins/base.js';
import type { RunMetrics, ScenarioResult } from '../schemas/result.js';
import { log } from '../utils/logger.js';

export { modelSlug, scenarioSlug } from '../plugins/base.js';
export type ScenarioRunResult = ScenarioResult;

function clientTools(plugin: TournamentPlugin): ModelToolDefinition[] | undefined {
  return plugin.tools?.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

async function runTool(
  plugin: TournamentPlugin,
  name: string,
  input: unknown,
): Promise<ToolCall> {
  const args = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown> : {};
  const tool = plugin.tools?.find(candidate => candidate.name === name);
  if (!tool) {
    return { name, arguments: args, result: `Unknown tool: ${name}`, valid: false };
  }
  try {
    return { name, arguments: args, result: await tool.handler(args), valid: true };
  } catch (error) {
    return {
      name,
      arguments: args,
      result: error instanceof Error ? error.message : String(error),
      valid: false,
    };
  }
}

export async function runScenario(
  model: CandidateModel,
  scenario: TestCase,
  plugin: TournamentPlugin,
  outputDir: string,
): Promise<ScenarioRunResult> {
  const scenarioDir = path.join(
    outputDir,
    'candidates',
    modelSlug(model.id),
    scenarioSlug(scenario),
  );
  fs.mkdirSync(scenarioDir, { recursive: true });

  const turns: Turn[] = [{
    turn: 0,
    role: 'participant',
    content: scenario.setupMessage,
  }];
  const metrics: RunMetrics = {
    candidateInputTokens: 0,
    candidateOutputTokens: 0,
    participantInputTokens: 0,
    participantOutputTokens: 0,
    totalTimeMs: 0,
    toolCallCount: 0,
  };
  const messages: ModelMessage[] = [{ role: 'user', content: scenario.setupMessage }];
  const client = getModelClient('openrouter');
  const system = plugin.buildCandidatePrompt(scenario);
  const tools = clientTools(plugin);

  try {
    log(`  [${model.name}/${scenario.name}] Starting`);
    for (let turnNumber = 1; turnNumber <= scenario.maxTurns; turnNumber++) {
      const startedAt = Date.now();
      const turnToolCalls: ToolCall[] = [];
      const textParts: string[] = [];
      let inputTokens = 0;
      let outputTokens = 0;
      let toolBudgetExhausted = false;

      for (let toolRound = 0; toolRound <= MAX_TOOL_ROUNDS; toolRound++) {
        const response = await client.createMessage({
          model: model.id,
          system,
          messages,
          max_tokens: MAX_TOKENS_CANDIDATE,
          tools,
        });
        inputTokens += response.usage.input_tokens;
        outputTokens += response.usage.output_tokens;
        if (response.text) textParts.push(response.text);

        const requestedTools = response.content.filter(block => block.type === 'tool_use');
        if (!requestedTools.length) {
          messages.push({ role: 'assistant', content: response.text });
          break;
        }
        if (toolRound === MAX_TOOL_ROUNDS) {
          // Tool budget exhausted mid-turn: record a degraded turn and keep the
          // conversation going — judges score the failure; it must not kill the run.
          messages.push({
            role: 'assistant',
            content: response.text || `[MAX_TOOL_ROUNDS exceeded — no text response]`,
          });
          toolBudgetExhausted = true;
          break;
        }

        messages.push({ role: 'assistant', content: response.content });
        const results = await Promise.all(requestedTools.map(block =>
          runTool(plugin, String(block.name), block.input)));
        turnToolCalls.push(...results);
        messages.push({
          role: 'user',
          content: requestedTools.map((block, index) => ({
            type: 'tool_result',
            tool_use_id: block.id,
            content: results[index].result,
          })),
        });
      }

      const totalTimeMs = Date.now() - startedAt;
      const candidateTurn: Turn = {
        turn: turnNumber,
        role: 'candidate',
        content: textParts.join('\n').trim()
          || (toolBudgetExhausted ? `[MAX_TOOL_ROUNDS exceeded — no text response]` : ''),
        ...(turnToolCalls.length ? { toolCalls: turnToolCalls } : {}),
        metrics: { ttfbMs: null, totalTimeMs, inputTokens, outputTokens },
      };
      turns.push(candidateTurn);
      metrics.candidateInputTokens += inputTokens;
      metrics.candidateOutputTokens += outputTokens;
      metrics.totalTimeMs += totalTimeMs;
      metrics.toolCallCount += turnToolCalls.length;
      log(`  [${model.name}/${scenario.name}] Turn ${turnNumber}/${scenario.maxTurns} (${totalTimeMs}ms, ${turnToolCalls.length} tool call(s))`);

      if (turnNumber < scenario.maxTurns) {
        const participantMessage = await plugin.generateParticipantMessage(
          scenario,
          turns,
          scenario.context,
        );
        turns.push({ turn: turnNumber, role: 'participant', content: participantMessage });
        messages.push({ role: 'user', content: participantMessage });
      }
    }

    fs.writeFileSync(path.join(scenarioDir, 'turns.json'), JSON.stringify(turns, null, 2));
    fs.writeFileSync(path.join(scenarioDir, 'metrics.json'), JSON.stringify(metrics, null, 2));
    return { success: true, turns, metrics };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fs.writeFileSync(path.join(scenarioDir, 'turns.json'), JSON.stringify(turns, null, 2));
    fs.writeFileSync(path.join(scenarioDir, 'metrics.json'), JSON.stringify(metrics, null, 2));
    fs.writeFileSync(path.join(scenarioDir, 'error.json'), JSON.stringify({ error: message }, null, 2));
    return { success: false, turns, metrics, error: message };
  }
}
