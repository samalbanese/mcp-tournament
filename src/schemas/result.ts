import { z } from 'zod';

export const ToolCallSchema = z.object({
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
  result: z.string(),
  id: z.string(),
  validation: z.object({
    valid: z.boolean(),
    errors: z.array(z.string()),
  }),
  round: z.number(),
});

export const TurnSchema = z.object({
  turn: z.number(),
  type: z.enum(['setup', 'player_turn']),
  playerMessage: z.string(),
  playerReflection: z.string().optional(),
  dmResponse: z.string(),
  toolCalls: z.array(ToolCallSchema),
  dmMetrics: z.object({
    ttfbMs: z.number().nullable(),
    totalTimeMs: z.number(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    toolRounds: z.number(),
    toolCallCount: z.number(),
    narrativeLength: z.number(),
  }),
  playerMetrics: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    timeMs: z.number(),
  }).optional(),
});

export const ScenarioResultSchema = z.object({
  success: z.boolean(),
  turns: z.array(TurnSchema),
  metrics: z.object({
    dmInputTokens: z.number(),
    dmOutputTokens: z.number(),
    playerInputTokens: z.number(),
    playerOutputTokens: z.number(),
    totalTimeMs: z.number(),
    toolCallCount: z.number(),
    toolRounds: z.number(),
  }),
  error: z.string().optional(),
});

export type ToolCall = z.infer<typeof ToolCallSchema>;
export type Turn = z.infer<typeof TurnSchema>;
export type ScenarioResult = z.infer<typeof ScenarioResultSchema>;
