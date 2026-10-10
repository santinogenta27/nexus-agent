import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '@google/genai';
import type { Evidence, PriceObservation, ResearchResult } from '../src/types/agent.ts';
import { comparableRecurringPrices, executeSandbox, referenceMetrics } from '../server/analysis/sandbox.ts';
import { SynthesisSchema } from '../src/types/agent.ts';
import { repairDraft, runDeterministicChecks, summarizeCritic } from '../server/analysis/critic.ts';
import type { CriticContext, ReportDraft } from '../server/analysis/critic.ts';
import { applyVerdicts, assessHypotheses, churnAssessment, defaultHypotheses, deterministicSynthesis, modelContextReason, sanitizeModelContext } from '../server/agent/deductive.ts';
import { LlmUnavailableError, QUOTA_COOLDOWN_MS, QuotaGuard, classifyLlmError, isQuotaError } from '../server/agent/llmErrors.ts';

const corpus =
  'Acme helps teams plan projects. Built for engineering teams. Team $12 per user/month Business $240 per year Contact sales for custom pricing Start your free trial today Start now Contact sales';

const price = (p: Partial<PriceObservation> & Pick<PriceObservation, 'evidenceId' | 'amount'>): PriceObservation => ({
  currency: 'USD',
  product: null,
  item: null,
  unit: null,
  period: null,
  terms: [],
  ...p,
});

function liveResearch(): ResearchResult & { corpora: Record<string, string> } {
  const evidence: Evidence[] = [
    { id: 'E1', sourceId: 'S1', url: 'https://acme.test/', kind: 'value_prop', snippet: 'Acme helps teams plan projects.' },
    { id: 'E2', sourceId: 'S1', url: 'https://acme.test/', kind: 'audience', snippet: 'Built for engineering teams.' },
    { id: 'E3', sourceId: 'S2', url: 'https://acme.test/pricing', kind: 'pricing', snippet: 'Team $12 per user/month', context: 'Team' },
    { id: 'E4', sourceId: 'S2', url: 'https://acme.test/pricing', kind: 'pricing', snippet: 'Business $240 per year', context: 'Business' },
    { id: 'E5', sourceId: 'S2', url: 'https://acme.test/pricing', kind: 'custom_pricing', snippet: 'Contact sales for custom pricing' },
    { id: 'E6', sourceId: 'S2', url: 'https://acme.test/pricing', kind: 'friction', signal: 'contact_sales', contextual: true, snippet: 'Contact sales for custom pricing' },
    { id: 'E7', sourceId: 'S1', url: 'https://acme.test/', kind: 'friction', signal: 'free_trial', contextual: true, snippet: 'Start your free trial today' },
    { id: 'E8', sourceId: 'S1', url: 'https://acme.test/', kind: 'friction', signal: 'contact_sales', contextual: false, snippet: 'Start now Contact sales' },
  ];
  return {
    target: { company: 'Acme', url: 'https://acme.test/', resolvedBy: 'user_url', candidatesTried: [] },
    status: 'live',
    statusReason: 'All 2 sources retrieved and parsed',
    sources: [
      { id: 'S1', url: 'https://acme.test/', kind: 'home', status: 'ok', bytes: 1, textChars: 500, durationMs: 1 },
      { id: 'S2', url: 'https://acme.test/pricing', kind: 'pricing', status: 'ok', bytes: 1, textChars: 500, durationMs: 1 },
    ],
    evidence,
    prices: [
      price({ evidenceId: 'E3', amount: 12, product: 'Team', unit: 'user', period: 'month' }),
      price({ evidenceId: 'E4', amount: 240, product: 'Business', period: 'year' }),
    ],
    percentFees: [],
    discardedPriceFragments: 0,
    durationMs: 10,
    corpora: { S1: corpus, S2: corpus },
  };
}

function emptyResearch(): ResearchResult & { corpora: Record<string, string> } {
  return {
    target: { company: 'Nobody', url: null, resolvedBy: 'unresolved', candidatesTried: [] },
    status: 'fallback',
    statusReason: 'No source could be retrieved and parsed',
    sources: [{ id: 'S1', url: 'https://nobody.test/', kind: 'home', status: 'failed', bytes: 0, textChars: 0, durationMs: 5, error: 'HTTP 503' }],
    evidence: [],
    prices: [],
    percentFees: [],
    discardedPriceFragments: 0,
    durationMs: 5,
    corpora: {},
  };
}

function setup(research: ResearchResult & { corpora: Record<string, string> }, goal = 'Assess Acme pricing and onboarding for startups') {
  const sandbox = executeSandbox(research);
  const hypotheses = assessHypotheses(defaultHypotheses(research.target.company, goal, 'saas'), research, sandbox.metrics);
  const ctx: CriticContext = {
    goal,
    churnGoal: /churn/i.test(goal),
    company: research.target.company,
    url: research.target.url,
    research,
    corpora: research.corpora,
    metrics: sandbox.metrics,
    reference: referenceMetrics(sandbox.input),
  };
  const synthesis = deterministicSynthesis({ company: research.target.company, url: research.target.url, goal, research, hypotheses, metrics: sandbox.metrics });
  const draft: ReportDraft = { synthesis, hypotheses: applyVerdicts(hypotheses, synthesis.hypothesisVerdicts), churn: churnAssessment(goal) };
  return { sandbox, hypotheses, ctx, synthesis, draft };
}

const metric = (sandbox: ReturnType<typeof executeSandbox>, id: string) => sandbox.metrics.find((m) => m.id === id);
const check = (draft: ReportDraft, ctx: CriticContext, id: string) => runDeterministicChecks(draft, ctx).checks.find((c) => c.id === id);

describe('sandbox', () => {
  it('computes metrics from linked prices and matches the independent reference', () => {
    const { sandbox } = setup(liveResearch());
    assert.equal(metric(sandbox, 'M1')?.value, 2);
    // Price levels compare like with like: the per-user Team price and the flat Business price are different units.
    const m2 = metric(sandbox, 'M2');
    assert.ok(m2?.value === 12 || m2?.value === 20);
    assert.equal(metric(sandbox, 'M5')?.status, 'insufficient_data', 'only one price per unit');
    assert.equal(metric(sandbox, 'M7')?.value, 50, '2 published / (2 + 1 plan-linked sales step + 1 custom-pricing mention)');
    assert.equal(metric(sandbox, 'M8')?.value, 1, 'the generic CTA is not counted as friction');
    assert.equal(metric(sandbox, 'M11')?.value, 1, 'the generic CTA is reported separately');
    const reference = referenceMetrics(sandbox.input);
    for (const m of sandbox.metrics) assert.equal(m.value, reference.get(m.id), m.id);
  });

  it('normalises yearly prices only within the same billing unit', () => {
    const research = liveResearch();
    research.prices = [
      price({ evidenceId: 'E3', amount: 12, unit: 'user', period: 'month' }),
      price({ evidenceId: 'E4', amount: 240, unit: 'user', period: 'year' }),
    ];
    const { sandbox } = setup(research);
    assert.deepEqual([metric(sandbox, 'M2')?.value, metric(sandbox, 'M3')?.value, metric(sandbox, 'M5')?.value], [12, 20, 1.67]);
    assert.match(metric(sandbox, 'M2')?.unit ?? '', /per user/);
  });

  it('reports insufficient data instead of inventing metrics when nothing was retrieved', () => {
    const { sandbox } = setup(emptyResearch());
    for (const m of sandbox.metrics) {
      assert.equal(m.status, 'insufficient_data', m.id);
      assert.equal(m.value, null, m.id);
    }
  });

  it('rejects invalid or unreferenced inputs before computing', () => {
    const research = liveResearch();
    research.prices.push(price({ evidenceId: 'E99', amount: 5, period: 'month' }));
    research.prices.push(price({ evidenceId: 'E3', amount: -4, period: 'month' }));
    const sandbox = executeSandbox(research);
    assert.equal(sandbox.rejectedInputs.length, 2);
    assert.equal(metric(sandbox, 'M1')?.value, 2);
  });
});

describe('hypotheses', () => {
  it('reports evidence coverage separately from verdict confidence', () => {
    const { hypotheses } = setup(liveResearch());
    const pricing = hypotheses.find((h) => h.area === 'pricing');
    assert.equal(pricing?.coverage, 'complete');
    assert.equal(pricing?.verdict, 'inconclusive');
    assert.equal(pricing?.verdictConfidence, null, 'an inconclusive verdict carries no confidence');
    assert.equal(pricing?.maxVerdictConfidence, 'high');
    assert.ok(hypotheses.find((h) => h.area === 'product')?.categoriesMissing.includes('Product features'));
  });

  it('does not count a generic "Contact sales" button as a sales gate', () => {
    const research = liveResearch();
    research.evidence = research.evidence.filter((e) => e.id !== 'E6' && e.id !== 'E5');
    const { hypotheses, synthesis } = setup(research);
    const friction = hypotheses.find((h) => h.area === 'friction');
    assert.ok(friction?.categoriesMissing.includes('Plan-linked sales or demo step'));
    assert.ok(!synthesis.risks.some((r) => /sales/i.test(r.title)), 'no sales-step risk from a CTA alone');
  });

  it('leaves every hypothesis untested when research fell back', () => {
    const { hypotheses } = setup(emptyResearch());
    assert.ok(hypotheses.every((h) => h.coverage === 'none' && h.maxVerdictConfidence === null));
  });
});

describe('critic', () => {
  it('passes the evidence-only deterministic report', () => {
    const { draft, ctx } = setup(liveResearch());
    const { checks, issues } = runDeterministicChecks(draft, ctx);
    const failing = checks.filter((c) => c.status === 'fail');
    assert.deepEqual(failing, [], JSON.stringify(failing));
    assert.equal(summarizeCritic({ checks, issues }, 'live', 'unavailable').status, 'pass');
  });

  it('flags invented numbers and unknown citations, and repair removes them', () => {
    const { draft, ctx, synthesis } = setup(liveResearch());
    const bad: ReportDraft = {
      ...draft,
      synthesis: {
        ...draft.synthesis,
        executiveSummary: 'Acme converts 37% of trials and earns $4.2M ARR.',
        confirmedFindings: [...draft.synthesis.confirmedFindings, { statement: 'Acme has 900 customers.', evidenceIds: ['E42'] }],
      },
    };
    const result = runDeterministicChecks(bad, ctx);
    assert.equal(result.checks.find((c) => c.id === 'C2')?.status, 'fail');
    assert.equal(result.checks.find((c) => c.id === 'C6')?.status, 'fail');
    assert.equal(summarizeCritic(result, 'live', 'unavailable').status, 'fail');

    const repaired = repairDraft(bad, ctx, synthesis);
    assert.equal(repaired.draft.synthesis.executiveSummary, synthesis.executiveSummary);
    assert.ok(!repaired.draft.synthesis.confirmedFindings.some((f) => f.evidenceIds.includes('E42')));
    assert.deepEqual(runDeterministicChecks(repaired.draft, ctx).checks.filter((c) => c.status === 'fail'), []);
    assert.ok(repaired.notes.length >= 2);
  });

  it('rejects supported verdicts without evidence or confidence', () => {
    const { draft, ctx } = setup(liveResearch());
    const noEvidence: ReportDraft = { ...draft, synthesis: { ...draft.synthesis, hypothesisVerdicts: [{ id: 'H2', verdict: 'supported', confidence: 'low', rationale: 'Obviously true.', evidenceIds: [] }] } };
    assert.equal(check(noEvidence, ctx, 'C5')?.status, 'fail');
    const noConfidence: ReportDraft = { ...draft, synthesis: { ...draft.synthesis, hypothesisVerdicts: [{ id: 'H2', verdict: 'supported', confidence: null, rationale: 'Prices are published.', evidenceIds: ['E3'] }] } };
    assert.equal(check(noConfidence, ctx, 'C5')?.status, 'fail');
  });

  it('caps verdict confidence by evidence coverage', () => {
    const { draft, ctx } = setup(liveResearch());
    // H1 (product) has partial coverage: medium is the maximum.
    const tooHigh: ReportDraft = { ...draft, synthesis: { ...draft.synthesis, hypothesisVerdicts: [{ id: 'H1', verdict: 'supported', confidence: 'high', rationale: 'Positioning is stated.', evidenceIds: ['E1'] }] } };
    assert.match(check(tooHigh, ctx, 'C5')?.detail ?? '', /allows at most medium/);
    const ok: ReportDraft = { ...draft, synthesis: { ...draft.synthesis, hypothesisVerdicts: [{ id: 'H1', verdict: 'supported', confidence: 'medium', rationale: 'Positioning is stated.', evidenceIds: ['E1'] }] } };
    assert.equal(check(ok, ctx, 'C5')?.status, 'pass');
  });

  it('rejects a confidence attached to an inconclusive verdict', () => {
    const { draft, ctx } = setup(liveResearch());
    const bad: ReportDraft = { ...draft, synthesis: { ...draft.synthesis, hypothesisVerdicts: [{ id: 'H1', verdict: 'inconclusive', confidence: 'high', rationale: 'Unclear.', evidenceIds: [] }] } };
    assert.equal(check(bad, ctx, 'C5')?.status, 'fail');
  });

  it('rejects evaluations stated as observed facts', () => {
    const { draft, ctx } = setup(liveResearch());
    const bad: ReportDraft = {
      ...draft,
      synthesis: { ...draft.synthesis, confirmedFindings: [{ statement: 'Acme has onboarding friction because of its sales step.', evidenceIds: ['E6'] }] },
    };
    assert.match(check(bad, ctx, 'C5')?.detail ?? '', /evaluation/);
  });

  it('keeps churn diagnoses provisional and non-causal', () => {
    const goal = 'Diagnose churn for Acme';
    const { draft, ctx } = setup(liveResearch(), goal);
    assert.equal(draft.churn.status, 'provisional');
    assert.equal(check(draft, ctx, 'C8')?.status, 'pass');
    const bad: ReportDraft = { ...draft, synthesis: { ...draft.synthesis, executiveSummary: 'Sales-gated pricing causes churn among small teams.' } };
    assert.equal(check(bad, ctx, 'C8')?.status, 'fail');
  });

  it('detects citations that do not match retrieved content', () => {
    const research = liveResearch();
    research.evidence[0] = { ...research.evidence[0], snippet: 'Acme is the market leader.' };
    const { draft, ctx } = setup(research);
    assert.equal(check(draft, ctx, 'C3')?.status, 'fail');
  });

  it('reports limitations, not findings, when no source was retrieved', () => {
    const { draft, ctx, synthesis } = setup(emptyResearch());
    assert.equal(synthesis.confirmedFindings.length, 0);
    assert.match(synthesis.executiveSummary, /No public source/);
    const result = runDeterministicChecks(draft, ctx);
    assert.equal(result.checks.find((c) => c.id === 'C1')?.status, 'fail');
    assert.equal(summarizeCritic(result, 'fallback', 'unavailable').status, 'pass_with_limitations');
  });
});

describe('sandbox price levels (M2–M5) compare only compatible recurring prices', () => {
  const levels = (prices: PriceObservation[]) => {
    const research = liveResearch();
    research.prices = prices;
    const sandbox = executeSandbox(research);
    const get = (id: string) => sandbox.metrics.find((m) => m.id === id);
    const reference = referenceMetrics(sandbox.input);
    for (const id of ['M2', 'M3', 'M4', 'M5']) assert.equal(get(id)?.value, reference.get(id), `${id} sandbox = reference`);
    return { M2: get('M2'), M3: get('M3'), M4: get('M4'), M5: get('M5') };
  };

  it('never mixes billing units (member, seat, domain, credits) or add-ons', () => {
    const m = levels([
      price({ evidenceId: 'E3', amount: 10, product: 'Plus', unit: 'member', period: 'month' }),
      price({ evidenceId: 'E3', amount: 20, product: 'Business', unit: 'member', period: 'month' }),
      price({ evidenceId: 'E4', amount: 240, product: 'Enterprise', unit: 'member', period: 'year' }),
      price({ evidenceId: 'E4', amount: 15, product: 'Plus', unit: 'seat', period: 'month' }),
      price({ evidenceId: 'E4', amount: 8, product: 'Sites › Custom domain', unit: 'domain', period: 'month' }),
      price({ evidenceId: 'E4', amount: 10, product: 'Agents', unit: '1,000 credits', period: 'month' }),
      price({ evidenceId: 'E3', amount: 5, product: 'Plus', item: 'Additional storage', period: 'month' }),
    ]);
    assert.deepEqual([m.M2?.value, m.M3?.value, m.M4?.value, m.M5?.value], [10, 20, 20, 2], 'member prices only; 240/year = 20/month');
    assert.match(m.M2?.unit ?? '', /USD per member \/ month/);
    assert.match(m.M2?.note ?? '', /Excluded 4 recurring price/);
    assert.match(m.M2?.note ?? '', /1 add-on/);
  });

  it('does not infer a unit: "not stated" is never merged with a stated unit', () => {
    const chosen = comparableRecurringPrices([
      price({ evidenceId: 'E3', amount: 10, product: 'Plus', unit: null, period: 'month' }),
      price({ evidenceId: 'E3', amount: 20, product: 'Business', unit: 'user', period: 'month' }),
    ]);
    assert.equal(chosen.length, 1);
  });

  it('does not compare products of different families (e.g. two different add-on product lines)', () => {
    const chosen = comparableRecurringPrices([
      price({ evidenceId: 'E3', amount: 620, product: 'Billing › Pay monthly', period: 'month' }),
      price({ evidenceId: 'E4', amount: 90, product: 'Tax › Tax Complete', period: 'month' }),
    ]);
    assert.equal(chosen.length, 1);
  });

  it('returns insufficient_data with a reason when fewer than two prices are comparable', () => {
    const m = levels([
      price({ evidenceId: 'E3', amount: 10, product: 'Plus', unit: 'member', period: 'month' }),
      price({ evidenceId: 'E4', amount: 15, product: 'Team', unit: 'seat', period: 'month' }),
    ]);
    assert.equal(m.M5?.status, 'insufficient_data');
    assert.match(m.M5?.note ?? '', /Only one comparable recurring price.*2 incompatible group/);
  });

  it('returns insufficient_data when only add-ons are recurring', () => {
    const m = levels([price({ evidenceId: 'E3', amount: 5, product: 'Plus', item: 'Extra seats add-on', period: 'month' })]);
    for (const metric of [m.M2, m.M3, m.M4, m.M5]) {
      assert.equal(metric?.status, 'insufficient_data');
      assert.match(metric?.note ?? '', /Only add-on recurring prices/);
    }
  });
});

describe('hypothesis verdicts and critic coherence', () => {
  type V = ReportDraft['synthesis']['hypothesisVerdicts'][number];
  const withVerdict = (v: V) => {
    const { draft, ctx } = setup(liveResearch());
    const d: ReportDraft = { ...draft, synthesis: { ...draft.synthesis, hypothesisVerdicts: [v] } };
    return { check: check(d, ctx, 'C5'), d, ctx };
  };

  it('accepts all four verdicts in the Synthesizer schema', () => {
    const { synthesis } = setup(liveResearch());
    for (const verdict of ['supported', 'partially_supported', 'refuted', 'inconclusive'] as const) {
      const parsed = SynthesisSchema.safeParse({ ...synthesis, hypothesisVerdicts: [{ id: 'H1', verdict, confidence: verdict === 'inconclusive' ? null : 'low', rationale: 'r', evidenceIds: [] }] });
      assert.ok(parsed.success, verdict);
    }
  });

  it('accepts a coherent partially_supported verdict with supporting and contradicting evidence', () => {
    const { check: c5 } = withVerdict({ id: 'H2', verdict: 'partially_supported', confidence: 'medium', rationale: 'Prices are published but custom pricing exists.', evidenceIds: ['E3'], contradictingEvidenceIds: ['E5'], missingEvidence: [] });
    assert.equal(c5?.status, 'pass', c5?.detail);
  });

  it('rejects "supported" when contradicting evidence is cited', () => {
    const { check: c5 } = withVerdict({ id: 'H2', verdict: 'supported', confidence: 'medium', rationale: 'r', evidenceIds: ['E3'], contradictingEvidenceIds: ['E5'] });
    assert.match(c5?.detail ?? '', /use partially_supported/);
  });

  it('rejects "refuted" without contradicting evidence', () => {
    const { check: c5 } = withVerdict({ id: 'H3', verdict: 'refuted', confidence: 'low', rationale: 'r', evidenceIds: ['E7'] });
    assert.match(c5?.detail ?? '', /refuted without citing contradicting evidence/);
  });

  it('rejects partially_supported without contradicting or missing evidence on complete coverage, and with high confidence', () => {
    assert.match(withVerdict({ id: 'H2', verdict: 'partially_supported', confidence: 'low', rationale: 'r', evidenceIds: ['E3'] }).check?.detail ?? '', /names no contradicting or missing evidence/);
    assert.match(
      withVerdict({ id: 'H2', verdict: 'partially_supported', confidence: 'high', rationale: 'r', evidenceIds: ['E3'], missingEvidence: ['Enterprise price'] }).check?.detail ?? '',
      /cannot be high/,
    );
  });

  it('rejects citations unrelated to the hypothesis and to every confirmed finding', () => {
    // E8 is a generic "Contact sales" button: not product evidence and not cited by any finding.
    assert.match(withVerdict({ id: 'H1', verdict: 'supported', confidence: 'low', rationale: 'r', evidenceIds: ['E8'] }).check?.detail ?? '', /neither evidence for this hypothesis/);
  });

  it('rejects an id cited both for and against', () => {
    assert.match(
      withVerdict({ id: 'H2', verdict: 'partially_supported', confidence: 'low', rationale: 'r', evidenceIds: ['E3'], contradictingEvidenceIds: ['E3'] }).check?.detail ?? '',
      /both for and against/,
    );
  });

  it('keeps supporting, contradicting and missing evidence on the hypothesis, and repair downgrades invalid verdicts', () => {
    const { d, ctx, check: c5 } = withVerdict({ id: 'H2', verdict: 'supported', confidence: 'medium', rationale: 'r', evidenceIds: ['E3'], contradictingEvidenceIds: ['E5'] });
    assert.equal(c5?.status, 'fail');
    const applied = applyVerdicts(d.hypotheses, [{ id: 'H2', verdict: 'partially_supported', confidence: 'medium', rationale: 'r', evidenceIds: ['E3'], contradictingEvidenceIds: ['E5'], missingEvidence: ['x'] }]);
    const h2 = applied.find((h) => h.id === 'H2');
    assert.deepEqual([h2?.verdict, h2?.verdictEvidence, h2?.verdictContradicting, h2?.verdictMissing], ['partially_supported', ['E3'], ['E5'], ['x']]);
    const repaired = repairDraft(d, ctx, d.synthesis);
    const v = repaired.draft.synthesis.hypothesisVerdicts.find((x) => x.id === 'H2');
    assert.deepEqual([v?.verdict, v?.confidence, v?.contradictingEvidenceIds], ['inconclusive', null, []]);
  });
});

describe('model background (last resort)', () => {
  it('is not requested when the key pages were retrieved', () => {
    assert.equal(modelContextReason(liveResearch()), null);
  });
  it('is requested when nothing could be retrieved, naming the reason', () => {
    assert.match(modelContextReason(emptyResearch()) ?? '', /no usable source/);
  });
  it('is requested when a key page stayed unreadable after recovery', () => {
    const research = liveResearch();
    research.sources[1] = { ...research.sources[1], status: 'empty', error: 'The page appears to build its content with JavaScript' };
    assert.match(modelContextReason(research) ?? '', /acme\.test\/pricing/);
  });
  it('drops every sentence with figures, prices, percentages or URLs', () => {
    const statements = sanitizeModelContext(
      'Acme makes project planning software for engineering teams. It costs $12 per user. It has 40% market share. Founded in 2015. See https://acme.test for details. It is generally positioned as a lightweight alternative to larger suites.',
    );
    assert.deepEqual(statements, ['Acme makes project planning software for engineering teams.', 'It is generally positioned as a lightweight alternative to larger suites.']);
  });
});

describe('quota guard (HTTP 429)', () => {
  it('skips calls during the cool-down after a 429 and allows them afterwards', () => {
    const guard = new QuotaGuard();
    guard.assertAvailable(1_000);
    guard.markExhausted(1_000);
    assert.throws(
      () => guard.assertAvailable(1_000 + QUOTA_COOLDOWN_MS - 1),
      (e: unknown) => e instanceof LlmUnavailableError && e.kind === 'quota' && /no new request was sent/.test(e.message),
    );
    assert.doesNotThrow(() => guard.assertAvailable(1_000 + QUOTA_COOLDOWN_MS));
  });
  it('identifies 429s as quota errors so they are never retried', () => {
    assert.equal(isQuotaError(new ApiError({ status: 429, message: 'RESOURCE_EXHAUSTED' })), true);
    assert.equal(isQuotaError(new ApiError({ status: 503, message: 'high demand' })), false);
  });
});

describe('Gemini failure classification', () => {
  it('identifies quota exhaustion (HTTP 429)', () => {
    const result = classifyLlmError(new ApiError({ status: 429, message: '{"error":{"code":429,"message":"You exceeded your current quota","status":"RESOURCE_EXHAUSTED"}}' }));
    assert.equal(result.kind, 'quota');
    assert.match(result.message, /HTTP 429/);
    assert.match(result.message, /exceeded your current quota/);
  });

  it('distinguishes other HTTP errors, timeouts, invalid output and local guards', () => {
    assert.equal(classifyLlmError(new ApiError({ status: 503, message: 'high demand' })).kind, 'error');
    assert.equal(classifyLlmError(new Error('Gemini call timed out after 12000 ms')).kind, 'timeout');
    assert.equal(classifyLlmError(new Error('Schema validation failed: hypotheses: Required')).kind, 'invalid_output');
    assert.equal(classifyLlmError(new LlmUnavailableError('rate_guard', 'guard')).kind, 'rate_guard');
  });
});
