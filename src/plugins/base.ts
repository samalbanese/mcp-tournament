/**
 * Plugin interface for MCP Tournament domain plugins.
 * 
 * Plugins define WHAT to evaluate. The core pipeline defines HOW to evaluate.
 * A plugin provides test cases, prompt templates, and optional tool definitions
 * for a specific evaluation domain (D&D, coding, customer support, etc.).
 */

import type { z } from 'zod';

/** A single test case the candidate model must handle. */
export interface TestCase {
  id: string;
  name: string;
  description: string;
  
  /** The setup message sent to the candidate (e.g., "You are a DM. Here's the scenario...") */
  setupMessage: string;
  
  /** What the test is trying to measure (shown to judges) */
  goalCard: string;
  
  /** Number of conversation turns to run */
  minTurns: number;
  maxTurns: number;
  
  /** Optional: domain-specific context (character sheet, codebase, etc.) */
  context?: Record<string, unknown>;
  
  /** Optional: grading criteria specific to this test case */
  gradingCriteria?: GradingCriterion[];
}

export interface GradingCriterion {
  name: string;
  description: string;
  weight?: number; // Default 1.0
}

/** A message in the conversation between candidate and test participant. */
export interface Turn {
  turn: number;
  role: 'candidate' | 'participant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  metrics?: TurnMetrics;
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  content: string;
  isError?: boolean;
}

export interface TurnMetrics {
  ttfbMs: number | null;
  totalTimeMs: number;
  inputTokens: number;
  outputTokens: number;
}

/** A tool definition that the candidate can use during evaluation. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  handler: (args: Record<string, unknown>) => Promise<string>;
}

/**
 * The core plugin interface.
 * 
 * Every domain plugin must implement this interface.
 * The pipeline calls these methods at the appropriate phases.
 */
export interface TournamentPlugin {
  /** Unique identifier for this plugin */
  name: string;
  
  /** Human-readable description */
  description: string;
  
  /** Version */
  version: string;
  
  /** Test cases this plugin provides */
  scenarios: TestCase[];
  
  /**
   * Build the system prompt for the candidate model.
   * This tells the model what role to play and what to do.
   */
  buildCandidatePrompt(scenario: TestCase): string;
  
  /**
   * Build the prompt for a specific judge.
   * @param role - Judge role (e.g., 'accuracy', 'creativity', 'holistic')
   * @param scenario - The test case being evaluated
   * @param turns - The conversation to evaluate
   * @returns The user prompt for the judge
   */
  buildJudgePrompt(role: string, scenario: TestCase, turns: Turn[]): string;
  
  /**
   * Generate the next participant message.
   * This is what the "player" says in response to the candidate.
   * For D&D: the player describes their character's action.
   * For coding: the test system provides the next requirement.
   * For customer support: the simulated customer sends a message.
   */
  generateParticipantMessage(
    scenario: TestCase,
    turns: Turn[],
    context?: Record<string, unknown>
  ): Promise<string>;
  
  /** Optional: tools the candidate can use during evaluation */
  tools?: ToolDefinition[];
  
  /** Optional: custom scoring rubric (overrides default judge scoring) */
  scoringRubric?: ScoringRubric;
}

export interface ScoringRubric {
  dimensions: ScoringDimension[];
  /** How to combine dimension scores into final score */
  aggregation: 'mean' | 'weighted' | 'custom';
}

export interface ScoringDimension {
  name: string;
  description: string;
  weight: number;
  /** Which judge role primarily evaluates this dimension */
  primaryJudge: string;
}

/**
 * Built-in plugins that ship with the package.
 */
export const BUILTIN_PLUGINS = ['dnd', 'coding', 'customer-support'] as const;
export type BuiltinPlugin = typeof BUILTIN_PLUGINS[number];

// ── Slug helpers (ported from oracle-tournament) ────────

/** Slugify a model name for file paths */
export function modelSlug(model: string): string {
  return model.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
}

/** Slugify a scenario name for file paths */
export function scenarioSlug(scenario: TestCase | { name: string }): string {
  return scenario.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
}

// ── Runtime scenario registry ───────────────────────────

let _scenarios: TestCase[] = [];

export function setScenarios(scenarios: TestCase[]): void {
  _scenarios = scenarios;
}

export function getScenarios(): TestCase[] {
  return _scenarios;
}

export const SCENARIOS: TestCase[] = new Proxy([] as TestCase[], {
  get(_target, prop) {
    if (prop === 'length') return _scenarios.length;
    if (typeof prop === 'string' && !isNaN(Number(prop))) return _scenarios[Number(prop)];
    return (_scenarios as any)[prop];
  },
  *[Symbol.iterator]() {
    yield* _scenarios;
  },
});
