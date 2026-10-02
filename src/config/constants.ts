// API token limits
export const MAX_TOKENS_CANDIDATE = 4096;
// Reasoning tokens count against max_tokens. At 4096, DeepSeek V4 Pro on "low" effort spent
// the whole allowance thinking and returned empty answers; one business answer took 17.5K
// reasoning plus 1.8K answer tokens, so leave room well above that.
export const MAX_TOKENS_CANDIDATE_REASONING = 32768;
export const MAX_TOKENS_PARTICIPANT = 512;
// Reasoning tokens count against max_tokens.
export const MAX_TOKENS_PARTICIPANT_REASONING = 8192;
export const MAX_TOKENS_JUDGE = 16384;
// Reasoning tokens count against max_tokens.
export const MAX_TOKENS_JUDGE_REASONING = 32768;
export const MAX_TOKENS_SYNTHESIS = 4096;
// Reasoning tokens count against max_tokens.
export const MAX_TOKENS_SYNTHESIS_REASONING = 16384;

// Conversation limits
export const MAX_TOOL_ROUNDS = 8;
export const MAX_TURNS = 5;
export const MIN_TURNS = 3;

// Timeouts: judge/synthesis calls generate up to 16K tokens on budget models, and reasoning
// candidates up to 32K; a 19K-token DeepSeek reply took 4.5 minutes. 120s aborts killed real runs.
export const API_TIMEOUT_MS = 600_000;
export const RETRY_ATTEMPTS = 2;
export const RETRY_BASE_DELAY_MS = 2000;

// Scoring thresholds
export const MIN_QUALITY_BAR = 6.0;
export const MIN_SCENARIO_SCORE = 4.0;
export const TIER_GAP_THRESHOLD = 1.0;
export const MIN_JUDGE_CONSENSUS = 3;

// Concurrency
export const DEFAULT_CONCURRENCY = 3;
