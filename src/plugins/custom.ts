import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { getModelClient } from '../clients/index.js';
import { MAX_TOKENS_PARTICIPANT } from '../config/constants.js';
import { PARTICIPANT_AGENT_ROUTE, resolveRoleModel } from '../config/judges.js';
import { buildCriteriaJsonInstruction } from '../prompts/judge-prompts.js';
import { logWarn } from '../utils/logger.js';
import type { TestCase, TournamentPlugin, Turn } from './base.js';
import { registerPlugin } from './index.js';

const CriterionSchema = z.object({
  name: z.string().min(1).max(60).regex(/^[a-z0-9_]+$/, 'must use lowercase letters, numbers, and underscores'),
  description: z.string().min(1).max(500),
}).strict();

const ScenarioSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9-]+$/, 'must be a lowercase slug'),
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional().default(''),
  prompt: z.string().min(1).max(20_000),
  rounds: z.number().int().min(1).max(5).optional().default(1),
  participantPersona: z.string().min(1).max(1_000).optional(),
  criteria: z.array(CriterionSchema).min(1).max(6),
}).strict();

export const BenchDefinitionSchema = z.object({
  name: z.string().min(1).max(60),
  description: z.string().min(1).max(200),
  scenarios: z.array(ScenarioSchema).min(1).max(10),
}).strict();

export type BenchDefinition = z.infer<typeof BenchDefinitionSchema>;

const FALLBACK_FOLLOW_UPS = [
  'Can you be more specific about the first step?',
  'What would you do if that approach did not work?',
  'What concrete result should I expect, and how would I measure it?',
  'Which tradeoff matters most here, and why?',
];

function generatedGoal(prompt: string): string {
  const compact = prompt.replace(/\s+/g, ' ').trim();
  const summary = compact.length > 140 ? `${compact.slice(0, 137)}...` : compact;
  return `Evaluate how well the candidate answers: ${summary}`;
}

export function createCustomPlugin(definition: BenchDefinition): TournamentPlugin {
  const scenarios: TestCase[] = definition.scenarios.map(scenario => ({
    id: scenario.id,
    name: scenario.name,
    description: scenario.description,
    setupMessage: scenario.prompt,
    goalCard: scenario.description || generatedGoal(scenario.prompt),
    minTurns: scenario.rounds,
    maxTurns: scenario.rounds,
    gradingCriteria: scenario.criteria,
  }));

  return {
    name: definition.name,
    description: definition.description,
    version: '1.0.0',
    scenarios,

    buildCandidatePrompt(): string {
      return `Answer the participant's task directly. Be concrete, specific, and useful. Do not include meta-commentary about evaluation, scoring, or being judged.`;
    },

    buildJudgePrompt(role: string, scenario: TestCase, turns: Turn[]): string {
      const criteria = scenario.gradingCriteria ?? [];
      const transcript = turns.map(turn => `[Turn ${turn.turn} - ${turn.role}]: ${turn.content}`).join('\n\n');
      return `You are the ${role} judge for a general-purpose AI response benchmark.

Goal:
${scenario.goalCard}

Score only these criteria:
${criteria.map(criterion => `- ${criterion.name}: ${criterion.description}`).join('\n')}

Full conversation transcript:
${transcript}

${buildCriteriaJsonInstruction(criteria)}`;
    },

    async generateParticipantMessage(scenario: TestCase, turns: Turn[]): Promise<string> {
      const scenarioDefinition = definition.scenarios.find(item => item.id === scenario.id);
      if (!scenarioDefinition) return scenario.setupMessage;
      const candidateTurns = turns.filter(turn => turn.role === 'candidate');
      if (candidateTurns.length === 0) return scenarioDefinition.prompt;
      if (scenarioDefinition.rounds === 1) return scenarioDefinition.prompt;

      const fallback = FALLBACK_FOLLOW_UPS[(candidateTurns.length - 1) % FALLBACK_FOLLOW_UPS.length];
      if (!process.env.OPENROUTER_API_KEY && !process.env.OPENROUTER_DICE_ORACLE_API_KEY) return fallback;

      const persona = scenarioDefinition.participantPersona ?? 'an engaged participant who wants a practical, specific answer';
      try {
        const response = await getModelClient(PARTICIPANT_AGENT_ROUTE).createMessage({
          model: resolveRoleModel('participant'),
          system: `You are ${persona}. Stay in character. React to the candidate's last answer and push deeper with exactly one follow-up question. Never answer the original task yourself. Keep your response to 80 words or fewer.`,
          messages: [{
            role: 'user',
            content: `Original task:\n${scenarioDefinition.prompt}\n\nCandidate's last answer:\n${candidateTurns.at(-1)?.content ?? ''}\n\nAsk the next follow-up.`,
          }],
          max_tokens: MAX_TOKENS_PARTICIPANT,
        });
        return response.text.trim() || fallback;
      } catch {
        return fallback;
      }
    },
  };
}

export interface LoadBenchesResult {
  loaded: string[];
  errors: Array<{ file: string; error: string }>;
}

export function getPackageBenchesDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'benches');
}

function isSameDirectory(left: string, right: string): boolean {
  const normalize = (directory: string): string => {
    const resolved = path.resolve(directory);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

export function loadDiscoveredBenches(cwd = process.cwd()): LoadBenchesResult {
  const packageBenchesDir = getPackageBenchesDir();
  const result = loadBenches(packageBenchesDir);
  const cwdBenchesDir = path.join(cwd, 'benches');
  if (!isSameDirectory(packageBenchesDir, cwdBenchesDir)) {
    const overlay = loadBenches(cwdBenchesDir);
    result.loaded.push(...overlay.loaded);
    result.errors.push(...overlay.errors);
  }
  return result;
}

export function readBenchDefinitions(benchesDir: string): BenchDefinition[] {
  if (!fs.existsSync(benchesDir)) return [];
  const definitions: BenchDefinition[] = [];
  for (const file of fs.readdirSync(benchesDir).filter(name => name.endsWith('.json')).sort()) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(benchesDir, file), 'utf8')) as unknown;
      definitions.push(BenchDefinitionSchema.parse(raw));
    } catch {
      // The loader reports invalid files; this read path returns saved valid definitions only.
    }
  }
  return definitions;
}

export function loadBenches(benchesDir: string): LoadBenchesResult {
  const result: LoadBenchesResult = { loaded: [], errors: [] };
  if (!fs.existsSync(benchesDir)) return result;

  for (const file of fs.readdirSync(benchesDir).filter(name => name.endsWith('.json')).sort()) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(benchesDir, file), 'utf8')) as unknown;
      const definition = BenchDefinitionSchema.parse(raw);
      registerPlugin(createCustomPlugin(definition));
      result.loaded.push(definition.name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push({ file, error: message });
      logWarn(`Skipping bench ${file}: ${message}`);
    }
  }
  return result;
}
