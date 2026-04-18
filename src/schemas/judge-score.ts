import { z } from 'zod';

export const CriterionScoreSchema = z.object({
  score: z.number().int().min(1).max(10),
  justification: z.string(),
  quotes: z.array(z.string()),
  improvement: z.string(),
});

export const JudgeScoreSchema = z.object({
  scores: z.record(z.string(), CriterionScoreSchema),
  rule_errors: z.array(z.string()),
  tool_errors: z.array(z.string()),
  flags: z.array(z.string()),
  overall_impression: z.string(),
});

export type CriterionScore = z.infer<typeof CriterionScoreSchema>;
export type JudgeScore = z.infer<typeof JudgeScoreSchema>;
