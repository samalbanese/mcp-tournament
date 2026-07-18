# Writing a Domain Plugin

A plugin defines **what** to evaluate. The pipeline defines **how**. Adding a new
evaluation domain — legal drafting, SQL generation, customer support — is one
TypeScript file implementing `TournamentPlugin` (see `src/plugins/base.ts`).

## The interface, in practice

```ts
import type { TournamentPlugin, TestCase, Turn } from './base.js';

export const sqlPlugin: TournamentPlugin = {
  name: 'sql',
  description: 'Evaluates models as SQL analysts against a fixed schema',
  version: '0.1.0',

  // 1. Test cases: what the candidate is asked to do.
  scenarios: [
    {
      id: 'sql-joins',
      name: 'The Three-Way Join',
      description: 'Multi-table joins with aggregation',
      setupMessage: 'You are a SQL analyst. Schema: ... Write a query that ...',
      goalCard: 'Test: correct joins, correct aggregation, readable SQL',
      minTurns: 2,
      maxTurns: 4,
      gradingCriteria: [
        { name: 'correctness', description: 'Query returns the right rows' },
        { name: 'readability', description: 'Clear aliases, sensible structure' },
      ],
    },
  ],

  // 2. The candidate's system prompt for a scenario.
  buildCandidatePrompt(scenario: TestCase): string {
    return `You are an expert SQL analyst...\n\n${scenario.setupMessage}`;
  },

  // 3. What each judge is asked to evaluate.
  buildJudgePrompt(role: string, scenario: TestCase, turns: Turn[]): string {
    const transcript = turns.map(t => `[${t.role}]: ${t.content}`).join('\n\n');
    return `Score this SQL session.\nCriteria: ...\nTranscript:\n${transcript}`;
  },

  // 4. The simulated counterpart (reviewer, customer, player...).
  //    Call an LLM through the client registry, or return scripted follow-ups.
  async generateParticipantMessage(scenario, turns) {
    return 'The query timed out on the orders table. Can you optimize it?';
  },

  // 5. Optional: tools the candidate may call (executed by the pipeline).
  tools: [
    {
      name: 'run_query',
      description: 'Execute SQL against the test database',
      parameters: { type: 'object', properties: { sql: { type: 'string' } } },
      handler: async args => JSON.stringify(fakeExecute(String(args.sql))),
    },
  ],
};
```

Register it in `src/plugins/index.ts` and it is immediately usable from the CLI
(`--plugin sql`) and every MCP tool.

## Design notes

- **Judges see what you show them.** `buildJudgePrompt` controls the entire
  judging context. Include the grading criteria by name — judge output is parsed
  against them into `JudgeScore` (`src/schemas/judge-score.ts`).
- **The participant drives realism.** An LLM-backed participant (see
  `src/plugins/dnd.ts`) produces far richer transcripts than canned lines. Keep a
  non-LLM fallback so the plugin loads and tests run without an API key.
- **Tools are optional but powerful.** The executor runs the tool loop
  (`MAX_TOOL_ROUNDS` guard included) and records every call — valid and invalid —
  into the results JSON, which the GUI renders for inspection.
- **Cheap by default.** Scenario `maxTurns` is the main cost lever. The included
  demo run (3 models, 1 scenario, 3 judges) costs a few cents on OpenRouter.

## What the pipeline gives you for free

Per candidate × scenario: conversation execution with metrics, an N-judge panel
scored against your criteria, an arbiter synthesis that surfaces judge
disagreements, aggregation into `leaderboard.json`, and the static results
viewer under `gui/` — all conforming to `docs/RESULTS_FORMAT.md`.
