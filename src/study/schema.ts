import { z } from 'zod';
import { ModelRefSchema } from '../run-plan.js';

export const StudyFamilySchema = z.string().regex(/^[a-z0-9-]{2,30}$/);

export const StudySchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{3,40}$/),
  title: z.string().trim().min(1).max(120),
  reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high']).optional(),
  benches: z.array(z.object({
    bench: z.string().trim().min(1),
    label: z.string().trim().min(1).max(40),
    scenarios: z.array(z.string().trim().min(1)).min(1),
  }).strict()).min(1),
  candidates: z.array(z.object({
    ref: ModelRefSchema,
    family: StudyFamilySchema,
    label: z.string().trim().min(1).max(40),
  }).strict()).min(2).max(8),
  judges: z.array(z.object({
    ref: ModelRefSchema,
    family: StudyFamilySchema,
  }).strict()).min(2).max(5),
  judgeLens: z.string().trim().min(1).max(1000),
  participant: ModelRefSchema,
  synthesizer: ModelRefSchema,
}).strict();

export type Study = z.infer<typeof StudySchema>;

export class StudyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StudyError';
  }
}

export function parseStudy(input: unknown): Study {
  const parsed = StudySchema.safeParse(input);
  if (!parsed.success) {
    throw new StudyError(parsed.error.issues.map(issue =>
      `${issue.path.join('.') || 'study'}: ${issue.message}`).join('\n'));
  }
  const study = parsed.data;
  const seenCandidates = new Set<string>();
  const seenJudges = new Set<string>();
  const seenFamilies = new Set<string>();
  const errors: string[] = [];
  study.candidates.forEach((candidate, index) => {
    if (seenCandidates.has(candidate.ref)) errors.push(`candidates.${index}.ref: duplicate candidate "${candidate.ref}"`);
    seenCandidates.add(candidate.ref);
  });
  study.judges.forEach((judge, index) => {
    if (seenJudges.has(judge.ref)) errors.push(`judges.${index}.ref: duplicate judge "${judge.ref}"`);
    if (seenFamilies.has(judge.family)) errors.push(`judges.${index}.family: duplicate judge family "${judge.family}"`);
    seenJudges.add(judge.ref);
    seenFamilies.add(judge.family);
  });
  if (errors.length) throw new StudyError(errors.join('\n'));
  return study;
}
