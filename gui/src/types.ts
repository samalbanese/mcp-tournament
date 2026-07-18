export type Confidence = 'high' | 'medium' | 'contested';
export interface RunIndex { runs: string[] }
export interface Candidate { id: string; name: string; tier: string }
export interface JudgeManifest { role: string; name: string; model: string }
export interface ScenarioManifest { id: string; name: string }
export interface RunManifest { runId: string; plugin: string; createdAt: string; candidates: Candidate[]; judges: JudgeManifest[]; synthesizer: { model: string }; scenarios: ScenarioManifest[] }
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