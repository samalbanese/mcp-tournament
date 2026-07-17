// API token limits
export const MAX_TOKENS_CANDIDATE = 4096;
export const MAX_TOKENS_PARTICIPANT = 512;
export const MAX_TOKENS_JUDGE = 16384;
export const MAX_TOKENS_SYNTHESIS = 4096;

// Conversation limits
export const MAX_TOOL_ROUNDS = 8;
export const MAX_TURNS = 5;
export const MIN_TURNS = 3;

// Timeouts
export const API_TIMEOUT_MS = 120_000;
export const RETRY_ATTEMPTS = 2;
export const RETRY_BASE_DELAY_MS = 2000;

// Scoring thresholds
export const MIN_QUALITY_BAR = 6.0;
export const MIN_SCENARIO_SCORE = 4.0;
export const TIER_GAP_THRESHOLD = 1.0;
export const MIN_JUDGE_CONSENSUS = 3;

// Concurrency
export const DEFAULT_CONCURRENCY = 3;
