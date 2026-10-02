import { z } from 'zod';
import { ModelRefError, parseModelRef } from '../config/model-ref.js';
import { REASONING_LEVELS, withReasoning } from '../config/reasoning.js';
import { ModelRefSchema } from '../run-plan.js';

export const StudyFamilySchema = z.string().regex(/^[a-z0-9-]{2,30}$/);

export const StudySchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{3,40}$/),
  title: z.string().trim().min(1).max(120),
  reasoningEffort: z.enum(REASONING_LEVELS).optional(),
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

export function studySeatRef(ref: string, study: Study): string {
  return withReasoning(parseModelRef(ref).ref, study.reasoningEffort);
}

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
  const errors: string[] = [];
  // Store every ref in canonical form, so "openrouter:x" and "x" are one model everywhere:
  // in the duplicate checks below, in saved progress, and when scores are matched to candidates.
  const canonical = (ref: string, where: string) => {
    try {
      return parseModelRef(ref).ref;
    } catch (error) {
      if (!(error instanceof ModelRefError)) throw error;
      errors.push(`${where}: ${error.message}`);
      return ref;
    }
  };
  const data = parsed.data;
  const study: Study = {
    ...data,
    candidates: data.candidates.map((candidate, index) => ({ ...candidate, ref: canonical(candidate.ref, `candidates.${index}.ref`) })),
    judges: data.judges.map((judge, index) => ({ ...judge, ref: canonical(judge.ref, `judges.${index}.ref`) })),
    participant: canonical(data.participant, 'participant'),
    synthesizer: canonical(data.synthesizer, 'synthesizer'),
  };
  const seenCandidates = new Set<string>();
  const seenJudges = new Set<string>();
  const seenFamilies = new Set<string>();
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
