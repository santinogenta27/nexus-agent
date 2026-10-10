import { RESEARCH_DEFAULTS } from '../research/retrieve.ts';

/**
 * Time limits for one agent run. Every LLM call is capped by its own timeout AND by the time left in the run, so the
 * run budget must leave room for the full sequence Supervisor → Retrieval → Synthesizer → Critic judge; otherwise a
 * later step would be cut short by an earlier one.
 */
export const SUPERVISOR_TIMEOUT_MS = 12_000;
export const RESEARCH_BUDGET_MS = RESEARCH_DEFAULTS.budgetMs;
export const SYNTHESIZER_TIMEOUT_MS = 50_000;
export const JUDGE_TIMEOUT_MS = 30_000;
/** Background-knowledge request, only made when web retrieval could not provide enough content. */
export const MODEL_CONTEXT_TIMEOUT_MS = 15_000;
/** Slack for parsing, sandbox, assembly and network jitter between steps. */
export const STEP_MARGIN_MS = 6_000;

export const RUN_BUDGET_MS = SUPERVISOR_TIMEOUT_MS + RESEARCH_BUDGET_MS + SYNTHESIZER_TIMEOUT_MS + JUDGE_TIMEOUT_MS + STEP_MARGIN_MS;

/** The Synthesizer may run until this close to the run deadline (the judge then gets what is left). */
export const SYNTHESIZER_DEADLINE_MARGIN_MS = 4_000;
/** Model background must finish early enough to leave a full Synthesizer and judge budget. */
export const MODEL_CONTEXT_RESERVE_MS = SYNTHESIZER_TIMEOUT_MS + JUDGE_TIMEOUT_MS;
/** Minimum time left before another Synthesizer → Critic revision cycle is attempted. */
export const REVISION_MIN_REMAINING_MS = 35_000;

/** HTTP request timeout for the agent endpoint: comfortably above a full run, independent of Node's default. */
export const HTTP_REQUEST_TIMEOUT_MS = RUN_BUDGET_MS + 60_000;
