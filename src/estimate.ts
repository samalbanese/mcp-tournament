import { findCatalogPrice, type Catalog } from './catalog.js';
import { parseModelRef, type ParsedModelRef } from './config/model-ref.js';
import { seatRef, type ReasoningLevel } from './config/reasoning.js';
import type { ResolvedRunPlan } from './run-plan.js';

export interface CostEstimate {
  usd: number | null;
  display: string;
  excluded: string[];
  assumptions: string;
}

const ASSUMPTIONS = 'Per candidate and scenario, assume 1,500 input tokens growing by 700 per turn and ' +
  '600 output tokens per turn, 400 input and 120 output tokens per follow-up, transcript tokens plus ' +
  '1,000 input and 700 output tokens per judge, and 700 tokens per judge plus 800 input and 500 output ' +
  'tokens for synthesis when needed. Seats that reason add hidden reasoning output per call: ' +
  '500 (minimal) to 16,000 (max) tokens, 4,000 when a model reasons by default.';

const HIDDEN_REASONING: Record<ReasoningLevel, number> = {
  none: 0, minimal: 500, low: 2000, medium: 4000, high: 8000, xhigh: 12000, max: 16000,
};
const DEFAULT_REASONING_TOKENS = 4000;

function hidden(reasoning: ReasoningLevel | undefined, thinks: boolean | undefined): number {
  return reasoning ? HIDDEN_REASONING[reasoning] : thinks ? DEFAULT_REASONING_TOKENS : 0;
}

export function estimateRunCost(plan: ResolvedRunPlan, catalog: Catalog): CostEstimate {
  if (catalog.source === 'curated-fallback') {
    return { usd: null, display: 'Cost estimate unavailable (model catalog offline).', excluded: [], assumptions: ASSUMPTIONS };
  }
  let usd = 0;
  const excluded = new Set<string>();
  const priceTokens = (ref: ParsedModelRef, input: number, output: number) => {
    const price = findCatalogPrice(ref, catalog);
    if (!price) {
      excluded.add(ref.ref);
      return;
    }
    usd += (input * price.promptPrice + output * price.completionPrice) / 1e6;
  };

  for (const candidate of plan.candidates) {
    for (const scenario of plan.scenarios) {
      const turns = plan.turns ?? scenario.maxTurns;
      const candidateInput = 1500 * turns + 700 * turns * (turns - 1) / 2;
      priceTokens(parseModelRef(candidate.id), candidateInput, (600 + hidden(candidate.reasoning, candidate.thinks)) * turns);
      if (turns > 1) priceTokens(plan.participant, 400 * (turns - 1),
        (120 + hidden(plan.participant.reasoning, plan.participant.thinks)) * (turns - 1));
      const transcript = 600 * turns + 120 * (turns - 1);
      for (const judge of plan.judges) {
        priceTokens(parseModelRef(seatRef(judge.route, judge.model, judge.reasoning)), transcript + 1000,
          700 + hidden(judge.reasoning, judge.thinks));
      }
      if (!plan.quick && plan.judges.length >= 2) {
        priceTokens(plan.synthesizer, 700 * plan.judges.length + 800,
          500 + hidden(plan.synthesizer.reasoning, plan.synthesizer.thinks));
      }
    }
  }

  const amount = usd < 0.01 ? '< $0.01' : `$${usd.toFixed(2)}`;
  return {
    usd,
    display: `≈ ${amount} (rough, could be ±50%)${excluded.size ? ` (excludes: ${[...excluded].join(', ')})` : ''}`,
    excluded: [...excluded],
    assumptions: ASSUMPTIONS,
  };
}
