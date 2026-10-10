import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  HTTP_REQUEST_TIMEOUT_MS,
  JUDGE_TIMEOUT_MS,
  MODEL_CONTEXT_RESERVE_MS,
  RESEARCH_BUDGET_MS,
  RUN_BUDGET_MS,
  STEP_MARGIN_MS,
  SUPERVISOR_TIMEOUT_MS,
  SYNTHESIZER_DEADLINE_MARGIN_MS,
  SYNTHESIZER_TIMEOUT_MS,
} from '../server/agent/budget.ts';

describe('run time budget', () => {
  it('gives the Synthesizer 50 seconds', () => {
    assert.equal(SYNTHESIZER_TIMEOUT_MS, 50_000);
  });

  it('fits the whole worst-case sequence, so no step cuts the next one short', () => {
    assert.ok(RUN_BUDGET_MS >= SUPERVISOR_TIMEOUT_MS + RESEARCH_BUDGET_MS + SYNTHESIZER_TIMEOUT_MS + JUDGE_TIMEOUT_MS + STEP_MARGIN_MS);
    // Worst case: Supervisor and research use their full limits before the Synthesizer starts.
    const leftForSynth = RUN_BUDGET_MS - SUPERVISOR_TIMEOUT_MS - RESEARCH_BUDGET_MS;
    const synthBudget = Math.min(SYNTHESIZER_TIMEOUT_MS, leftForSynth - SYNTHESIZER_DEADLINE_MARGIN_MS);
    assert.equal(synthBudget, SYNTHESIZER_TIMEOUT_MS, 'the Synthesizer gets its full 50 s');
    assert.ok(leftForSynth - SYNTHESIZER_TIMEOUT_MS >= JUDGE_TIMEOUT_MS, 'the judge still gets its full 30 s afterwards');
  });

  it('keeps model background from eating into the Synthesizer and judge budgets', () => {
    assert.ok(MODEL_CONTEXT_RESERVE_MS >= SYNTHESIZER_TIMEOUT_MS + JUDGE_TIMEOUT_MS);
  });

  it('never lets the HTTP layer time out a request before the run can finish', () => {
    assert.ok(HTTP_REQUEST_TIMEOUT_MS > RUN_BUDGET_MS);
  });
});
