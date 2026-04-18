import { z } from 'zod';

export const FinalCriterionSchema = z.object({
  score: z.number(),
  confidence: z.enum(['high', 'medium', 'contested']),
  outliers: z.array(z.string()),
});

export const SynthesisSchema = z.object({
  final_scores: z.record(z.string(), FinalCriterionSchema),
  average_score: z.number(),
  rule_errors_confirmed: z.array(z.string()),
  assessment: z.string(),
  judge_agreement: z.string(),
});

export type FinalCriterion = z.infer<typeof FinalCriterionSchema>;
export type Synthesis = z.infer<typeof SynthesisSchema>;
