import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BenchDefinitionSchema,
  createCustomPlugin,
  getPackageBenchesDir,
  loadBenches,
  loadDiscoveredBenches,
  type BenchDefinition,
} from '../../src/plugins/custom.js';
import type { Turn } from '../../src/plugins/base.js';

const tempDirs: string[] = [];
afterEach(() => {
  for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const definition: BenchDefinition = {
  name: 'unit-test-bench',
  description: 'A small bench used to verify custom plugin behavior.',
  scenarios: [{
    id: 'one-turn',
    name: 'One Turn',
    description: '',
    prompt: 'Explain the first step clearly.',
    rounds: 1,
    criteria: [
      { name: 'clarity', description: 'The answer is easy to follow.' },
      { name: 'specificity', description: 'The answer gives concrete details.' },
    ],
  }],
};

describe('custom benches', () => {
  it('keeps every shipped bench definition valid', () => {
    const benchesDir = getPackageBenchesDir();
    const files = fs.readdirSync(benchesDir).filter(file => file.endsWith('.json'));
    expect(files).toHaveLength(3);
    for (const file of files) {
      expect(() => BenchDefinitionSchema.parse(JSON.parse(fs.readFileSync(path.join(benchesDir, file), 'utf8')))).not.toThrow();
    }
  });

  it.each([
    ['business-strategy', ['pricing-pivot', 'hire-or-outsource', 'wholesale-offer', 'inventory-cash-crunch'], 1],
    ['customer-support', ['billing-dispute', 'refund-abuse', 'shipping-delay-gift', 'cancellation-save'], 3],
    ['creative-writing', ['opening-chapter', 'launch-email', 'apology-post', 'product-page-rewrite'], 3],
  ] as const)('keeps the %s study scenarios complete and consistent', (name, expectedIds, rounds) => {
    const source = fs.readFileSync(path.join(getPackageBenchesDir(), `${name}.json`), 'utf8');
    const bench = BenchDefinitionSchema.parse(JSON.parse(source));
    const ids = bench.scenarios.map(scenario => scenario.id);

    expect(bench.name).toBe(name);
    expect(bench.scenarios).toHaveLength(4);
    expect(ids).toEqual(expect.arrayContaining([...expectedIds]));
    expect(new Set(ids).size).toBe(ids.length);
    expect(source).not.toContain('\u2014');
    expect(JSON.stringify(bench)).not.toContain('\u2014');
    for (const scenario of bench.scenarios) {
      expect(scenario.rounds).toBe(rounds);
      expect(scenario.criteria).toHaveLength(3);
      if (rounds > 1) expect(scenario.participantPersona?.trim()).toBeTruthy();
    }
  });

  it('loads shipped benches and a cwd overlay when launched elsewhere', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-tournament-cwd-'));
    tempDirs.push(directory);
    const benchesDir = path.join(directory, 'benches');
    fs.mkdirSync(benchesDir);
    const overlay = { ...definition, name: `cwd-overlay-${Date.now()}` };
    fs.writeFileSync(path.join(benchesDir, 'duplicate.json'), JSON.stringify({ ...definition, name: 'business-strategy' }));
    fs.writeFileSync(path.join(benchesDir, 'overlay.json'), JSON.stringify(overlay));

    const result = loadDiscoveredBenches(directory);

    expect(result.loaded).toEqual([
      'business-strategy',
      'creative-writing',
      'customer-support',
      overlay.name,
    ]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ file: 'duplicate.json' });
    expect(result.errors[0].error).toContain('already registered');
  });

  it('maps rounds and names every criterion explicitly in the judge prompt', () => {
    const plugin = createCustomPlugin(definition);
    const scenario = plugin.scenarios[0];
    const turns: Turn[] = [
      { turn: 0, role: 'participant', content: scenario.setupMessage },
      { turn: 1, role: 'candidate', content: 'Start with a written inventory.' },
    ];
    const prompt = plugin.buildJudgePrompt('holistic', scenario, turns);
    expect(scenario.minTurns).toBe(1);
    expect(scenario.maxTurns).toBe(1);
    for (const criterion of definition.scenarios[0].criteria) {
      expect(prompt).toContain(criterion.name);
      expect(prompt).toContain(`"${criterion.name}"`);
    }
  });

  it('loads valid JSON and reports invalid JSON without crashing', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-tournament-benches-'));
    tempDirs.push(directory);
    const valid = { ...definition, name: `temp-bench-${Date.now()}` };
    fs.writeFileSync(path.join(directory, 'valid.json'), JSON.stringify(valid));
    fs.writeFileSync(path.join(directory, 'invalid.json'), '{not json');

    const result = loadBenches(directory);

    expect(result.loaded).toEqual([valid.name]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].file).toBe('invalid.json');
  });
});
