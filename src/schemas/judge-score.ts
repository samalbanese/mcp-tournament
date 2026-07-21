import { z } from 'zod';

export const CriterionScoreSchema = z.object({
  // Judges emit half-scores ("score": 6.5) on rubric criteria; round rather
  // than reject, or the same judge/model pair fails every retry.
  score: z.number().min(1).max(10).transform(value => Math.round(value)),
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
