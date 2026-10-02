import { bootstrapInterval, krippendorffAlphaInterval, mean } from './stats.js';

export interface ScoreRow {
  runId: string;
  bench: string;
  benchLabel: string;
  scenarioId: string;
  scenarioName: string;
  candidateRef: string;
  candidateFamily: string;
  candidateLabel: string;
  judgeRole: string;
  judgeRef: string;
  judgeFamily: string;
  criterion: string;
  score: number;
}

export interface Interval { mean: number; low: number; high: number }

export interface StudyAnalysis {
  answers: { total: number; analyzed: number; dropped: number };
  leaderboards: Array<{
    bench: string | 'overall';
    label: string;
    rows: Array<{
      candidateRef: string;
      label: string;
      family: string;
      score: Interval;
      rank: number;
      tiedWith: string[];
      runIds: string[];
    }>;
  }>;
  selfPreference: Array<{
    judgeFamily: string;
    judgeRef: string;
    ownFamily: Interval | null;
    matrix: Record<string, number | null>;
  }>;
  singleJudgeWinners: Array<{
    judgeFamily: string;
    winnerRef: string;
    winnerLabel: string;
    scores: Record<string, number>;
  }>;
  agreement: { overall: number | null; byBench: Record<string, number | null> };
  contested: Array<{
    runId: string;
    bench: string;
    scenarioId: string;
    scenarioName: string;
    candidateRef: string;
    spread: number;
    byJudge: Record<string, number>;
  }>;
}

interface Answer {
  row: ScoreRow;
  judges: Map<string, { row: ScoreRow; score: number }>;
  score: number;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function groupBy<T>(values: T[], key: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const id = key(value);
    const group = groups.get(id);
    if (group) group.push(value);
    else groups.set(id, [value]);
  }
  return groups;
}

function scenarioUnits(answers: Answer[]): Answer[][] {
  return [...groupBy(answers, answer => JSON.stringify([answer.row.bench, answer.row.scenarioId]))]
    .sort(([left], [right]) => compare(left, right)).map(([, group]) => group);
}

function leaderboard(answers: Answer[], bench: string, label: string): StudyAnalysis['leaderboards'][number] {
  const scenarios = scenarioUnits(answers);
  const rows = [...groupBy(answers, answer => answer.row.candidateRef)].map(([candidateRef, candidate]) => {
    // Answer means weight judges equally; candidate means weight analyzed answers equally.
    const units = scenarios.map(scenario => scenario.filter(answer => answer.row.candidateRef === candidateRef)
      .map(answer => answer.score));
    const score = {
      mean: mean(candidate.map(answer => answer.score)),
      // Resample (bench, scenarioId) clusters, preserving all answers within each draw.
      ...bootstrapInterval(units, sample => mean(sample.flat())),
    };
    return {
      candidateRef, label: candidate[0].row.candidateLabel, family: candidate[0].row.candidateFamily,
      score, rank: 0, tiedWith: [] as string[],
      runIds: [...new Set(candidate.map(answer => answer.row.runId))].sort(compare),
    };
  });
  rows.sort((left, right) => right.score.mean - left.score.mean || compare(left.candidateRef, right.candidateRef));
  rows.forEach((row, index) => {
    row.rank = index + 1;
    // Inclusive interval overlap marks ties independently of the mean-based rank.
    row.tiedWith = rows.filter(other => other !== row
      && row.score.low <= other.score.high && other.score.low <= row.score.high)
      .map(other => other.candidateRef).sort(compare);
  });
  return { bench, label, rows };
}

export function analyzeStudy(rows: ScoreRow[]): StudyAnalysis {
  const sorted = [...rows].sort((left, right) =>
    compare(left.runId, right.runId) || compare(left.scenarioId, right.scenarioId)
    || compare(left.candidateRef, right.candidateRef) || compare(left.judgeRole, right.judgeRole)
    || compare(left.judgeRef, right.judgeRef) || compare(left.criterion, right.criterion)
    || left.score - right.score);
  // An answer is (runId, scenarioId, candidateRef); each judge contributes its returned-criteria mean.
  const answers = [...groupBy(sorted, row => JSON.stringify([row.runId, row.scenarioId, row.candidateRef])).values()]
    .map(group => {
      const judges = new Map([...groupBy(group, row => row.judgeRef)].map(([ref, criteria]) =>
        [ref, { row: criteria[0], score: mean(criteria.map(row => row.score)) }]));
      return { row: group[0], judges, score: mean([...judges.values()].map(judge => judge.score)) };
    });
  // Keep partially scored answers with at least two judges; count the rest as dropped.
  const analyzed = answers.filter(answer => answer.judges.size >= 2);
  const benches = [...groupBy(sorted, row => row.bench)].sort(([left], [right]) => compare(left, right));
  const judges = [...groupBy(sorted, row => row.judgeRef)].map(([, group]) => group[0])
    .sort((left, right) => compare(left.judgeRole, right.judgeRole) || compare(left.judgeRef, right.judgeRef));
  const families = [...new Set(sorted.map(row => row.candidateFamily))].sort(compare);
  const scenarios = scenarioUnits(analyzed);
  const selfPreference = judges.map(judge => {
    const offsets = scenarios.map(scenario => scenario.flatMap(answer => {
      const own = answer.judges.get(judge.judgeRef);
      if (!own) return [];
      const others = [...answer.judges].filter(([ref]) => ref !== judge.judgeRef).map(([, value]) => value.score);
      // Offset compares this judge with the mean of the other judges on the same answer.
      return [{ family: answer.row.candidateFamily, value: own.score - mean(others) }];
    }));
    const all = offsets.flat();
    const matrix = Object.fromEntries(families.map(family => {
      const values = all.filter(offset => offset.family === family).map(offset => offset.value);
      return [family, values.length ? mean(values) : null];
    }));
    // Self-preference is mean own-family offset minus mean offset on all other families.
    const preference = (sample: typeof offsets) => {
      const values = sample.flat();
      return mean(values.filter(offset => offset.family === judge.judgeFamily).map(offset => offset.value))
        - mean(values.filter(offset => offset.family !== judge.judgeFamily).map(offset => offset.value));
    };
    const estimate = preference(offsets);
    // Either missing comparison group makes the contrast unavailable.
    const ownFamily = Number.isFinite(estimate)
      ? { mean: estimate, ...bootstrapInterval(offsets, preference) } : null;
    return { judgeFamily: judge.judgeFamily, judgeRef: judge.judgeRef, ownFamily, matrix };
  });
  // Single-judge rankings average that judge's available answer scores; exact ties use candidateRef.
  const singleJudgeWinners = judges.flatMap(judge => {
    const candidates = [...groupBy(analyzed.filter(answer => answer.judges.has(judge.judgeRef)),
      answer => answer.row.candidateRef)].map(([ref, candidate]) => ({
      ref, label: candidate[0].row.candidateLabel,
      score: mean(candidate.map(answer => answer.judges.get(judge.judgeRef)!.score)),
    })).sort((left, right) => right.score - left.score || compare(left.ref, right.ref));
    if (!candidates.length) return [];
    return [{
      judgeFamily: judge.judgeFamily, winnerRef: candidates[0].ref, winnerLabel: candidates[0].label,
      scores: Object.fromEntries(candidates.map(candidate => [candidate.ref, candidate.score])),
    }];
  });
  // Agreement uses analyzed answers as units and judge means in role order, with missing judges null.
  const agreement = (scope: Answer[]) => krippendorffAlphaInterval(scope.map(answer =>
    judges.map(judge => answer.judges.get(judge.judgeRef)?.score ?? null)));
  // Contested answers have the largest max-minus-min judge spread, then stable evidence-key order.
  // byJudge is keyed by judge family (unique per study) so readers see which lab disagreed.
  const contested = analyzed.map(answer => {
    const scores = [...answer.judges.values()];
    const values = scores.map(judge => judge.score);
    return {
      runId: answer.row.runId, bench: answer.row.bench, scenarioId: answer.row.scenarioId,
      scenarioName: answer.row.scenarioName, candidateRef: answer.row.candidateRef,
      spread: Math.max(...values) - Math.min(...values),
      byJudge: Object.fromEntries(scores.map(judge => [judge.row.judgeFamily, judge.score])),
    };
  }).sort((left, right) => right.spread - left.spread || compare(left.runId, right.runId)
    || compare(left.scenarioId, right.scenarioId) || compare(left.candidateRef, right.candidateRef)).slice(0, 5);
  return {
    answers: { total: answers.length, analyzed: analyzed.length, dropped: answers.length - analyzed.length },
    leaderboards: [leaderboard(analyzed, 'overall', 'Overall'), ...benches.map(([bench, group]) =>
      leaderboard(analyzed.filter(answer => answer.row.bench === bench), bench, group[0].benchLabel))],
    selfPreference,
    singleJudgeWinners,
    agreement: {
      overall: agreement(analyzed),
      byBench: Object.fromEntries(benches.map(([bench]) =>
        [bench, agreement(analyzed.filter(answer => answer.row.bench === bench))])),
    },
    contested,
  };
}
