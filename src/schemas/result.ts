import { z } from 'zod';

export const ToolCallSchema = z.object({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()),
  result: z.string(),
  valid: z.boolean(),
});

export const TurnMetricsSchema = z.object({
  ttfbMs: z.number().nullable(),
  totalTimeMs: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
});

export const TurnSchema = z.object({
  turn: z.number().int().nonnegative(),
  role: z.enum(['candidate', 'participant']),
  content: z.string(),
  toolCalls: z.array(ToolCallSchema).optional(),
  metrics: TurnMetricsSchema.optional(),
});

export const RunMetricsSchema = z.object({
  candidateInputTokens: z.number().nonnegative(),
  candidateOutputTokens: z.number().nonnegative(),
  participantInputTokens: z.number().nonnegative(),
  participantOutputTokens: z.number().nonnegative(),
  totalTimeMs: z.number().nonnegative(),
  toolCallCount: z.number().int().nonnegative(),
});

export const ScenarioResultSchema = z.object({
  success: z.boolean(),
  turns: z.array(TurnSchema),
  metrics: RunMetricsSchema,
  error: z.string().optional(),
});

export type ToolCall = z.infer<typeof ToolCallSchema>;
export type Turn = z.infer<typeof TurnSchema>;
export type RunMetrics = z.infer<typeof RunMetricsSchema>;
export type ScenarioResult = z.infer<typeof ScenarioResultSchema>;
