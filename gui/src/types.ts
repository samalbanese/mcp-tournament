export type Confidence = 'high' | 'medium' | 'contested';
export interface RunIndex { runs: string[]; studies?: string[] }
export interface Candidate { id: string; name: string; tier: string; reasoning?: string }
export interface JudgeManifest { role: string; name: string; model: string; reasoning?: string }
export interface ScenarioManifest { id: string; name: string }
export interface RunManifest { runId: string; plugin: string; createdAt: string; candidates: Candidate[]; judges: JudgeManifest[]; synthesizer: { model: string; reasoning?: string }; scenarios: ScenarioManifest[] }
export interface FinalCriterion { score: number; confidence: Confidence; outliers: string[] }
export interface ScenarioScore { scenarioId: string; scenarioName: string; average: number; scores: Record<string, FinalCriterion>; ruleErrors: string[]; flags: string[] }
export interface LeaderboardEntry { modelId: string; modelName: string; tier: string; overallAverage: number; scenarioScores: ScenarioScore[] }
export interface ToolCall { name: string; arguments: Record<string, unknown>; result: string; valid: boolean }
export interface TurnMetrics { ttfbMs: number | null; totalTimeMs: number; inputTokens: number; outputTokens: number }
export interface Turn { turn: number; role: 'candidate' | 'participant'; content: string; toolCalls?: ToolCall[]; metrics?: TurnMetrics }
export interface RunMetrics { candidateInputTokens: number; candidateOutputTokens: number; participantInputTokens: number; participantOutputTokens: number; totalTimeMs: number; toolCallCount: number }
export interface CriterionScore { score: number; justification: string; quotes: string[]; improvement: string }
export interface JudgeScore { scores: Record<string, CriterionScore>; rule_errors: string[]; tool_errors: string[]; flags: string[]; overall_impression: string }
export interface Synthesis { final_scores: Record<string, FinalCriterion>; average_score: number; rule_errors_confirmed: string[]; assessment: string; judge_agreement: string }
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

export interface StudyMeta {
  runIds: string[];
  estimateUsd: number | null;
  actualUsd: number | null;
  startedAt: string;
  finishedAt: string;
  headlines?: Array<{ title: string; body: string }>;
}

export interface StudyDefinition {
  id: string;
  title: string;
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  benches: Array<{ bench: string; label: string; scenarios: string[] }>;
  candidates: Array<{ ref: string; family: string; label: string }>;
  judges: Array<{ ref: string; family: string }>;
  judgeLens: string;
  participant: string;
  synthesizer: string;
}
export interface StudyDocument { study: StudyDefinition; meta: StudyMeta; analysis: StudyAnalysis }
