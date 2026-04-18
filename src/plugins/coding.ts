/**
 * Coding Domain Plugin for MCP Tournament.
 * 
 * Evaluates AI models on code generation, debugging, refactoring, and review.
 * Test cases cover common coding tasks with measurable quality criteria.
 */

import type { TournamentPlugin, TestCase, Turn } from './base.js';

const CODING_SCENARIOS: TestCase[] = [
  {
    id: 'coding-function',
    name: 'Utility Function Generation',
    description: 'Generate a well-typed utility function from a natural language description',
    setupMessage: `Write a TypeScript function called \`deepMerge\` that recursively merges two objects, with these requirements:
- Generic type support (preserve type information)
- Handle arrays (concatenate by default, or replace if a flag is set)
- Handle null/undefined gracefully
- Support a custom merge strategy callback
- Export it as a named export`,
    goalCard: 'Test: code correctness, type safety, edge case handling, code style',
    minTurns: 1,
    maxTurns: 3,
    gradingCriteria: [
      { name: 'correctness', description: 'Code compiles and handles edge cases' },
      { name: 'type_safety', description: 'Proper TypeScript generics, no `any` abuse' },
      { name: 'readability', description: 'Clean, well-structured, idiomatic code' },
    ],
  },
  {
    id: 'coding-debug',
    name: 'Bug Diagnosis',
    description: 'Identify and fix a subtle bug in existing code',
    setupMessage: `This React component has a bug. Users report that the counter sometimes decrements when they click the increment button. Find and fix the bug.

\`\`\`tsx
function Counter() {
  const [count, setCount] = useState(0);
  
  useEffect(() => {
    const handler = () => setCount(c => c + 1);
    document.addEventListener('click', handler);
  }, []);
  
  return (
    <div>
      <p>Count: {count}</p>
      <button onClick={() => setCount(c => c + 1)}>Increment</button>
    </div>
  );
}
\`\`\``,
    goalCard: 'Test: debugging skill, root cause analysis, fix quality',
    minTurns: 1,
    maxTurns: 2,
  },
  {
    id: 'coding-review',
    name: 'Code Review',
    description: 'Review a pull request and provide actionable feedback',
    setupMessage: `Review this PR diff. Provide feedback on correctness, performance, security, and style.

\`\`\`diff
+ const query = \`SELECT * FROM users WHERE id = \${userId}\`;
+ const result = await db.query(query);
+ return result.rows[0];
\`\`\`

Context: This is a new API endpoint that fetches user data by ID. userId comes from req.params.id.`,
    goalCard: 'Test: security awareness (SQL injection), review quality, actionable feedback',
    minTurns: 1,
    maxTurns: 2,
  },
];

export const codingPlugin: TournamentPlugin = {
  name: 'coding',
  description: 'Code generation, debugging, refactoring, and review evaluation.',
  version: '1.0.0',
  scenarios: CODING_SCENARIOS,

  buildCandidatePrompt(scenario: TestCase): string {
    return `You are an expert software engineer. Write clean, correct, well-typed code. Explain your reasoning when helpful.\n\n${scenario.setupMessage}`;
  },

  buildJudgePrompt(role: string, scenario: TestCase, turns: Turn[]): string {
    const transcript = turns.map(t => `[${t.role}]: ${t.content}`).join('\n\n');

    const rolePrompts: Record<string, string> = {
      correctness: `Score this code for correctness. Does it compile? Handle edge cases? Produce expected output?\n\nTranscript:\n${transcript}`,
      style: `Score this code for style and readability. Is it idiomatic? Well-structured? Self-documenting?\n\nTranscript:\n${transcript}`,
      holistic: `Score this code overall. Would you approve this PR? Is it production-ready?\n\nTranscript:\n${transcript}`,
    };

    return rolePrompts[role] || rolePrompts.holistic;
  },

  async generateParticipantMessage(scenario: TestCase, turns: Turn[]): Promise<string> {
    // Coding plugin uses single-turn evaluations (no participant interaction needed)
    return 'Please proceed with your implementation.';
  },
};
