import type {
  ChurnAssessment,
  CriticCheck,
  CriticIssue,
  CriticJudge,
  CriticReport,
  HypothesisAssessment,
  MetricResult,
  ResearchResult,
  Synthesis,
} from '../../src/types/agent.ts';
import { collapse } from '../research/extract.ts';
import { exceedsCap } from '../agent/deductive.ts';

export interface CriticContext {
  goal: string;
  churnGoal: boolean;
  company: string;
  url: string | null;
  research: ResearchResult;
  corpora: Record<string, string>;
  metrics: MetricResult[];
  reference: Map<string, number | null>;
}

export interface ReportDraft {
  synthesis: Synthesis;
  hypotheses: HypothesisAssessment[];
  churn: ChurnAssessment;
}

// ---------------------------------------------------------------------------
// Number grounding
// ---------------------------------------------------------------------------

const NUMBER_RE = /(?<![A-Za-z0-9.])[$€£]?\d+(?:[.,]\d+)*\s?%?/g;
const ID_RE = /\b[EHMS]\d+\b/g;

function canonicalNumbers(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.replace(ID_RE, ' ').match(NUMBER_RE) ?? []) {
    let token = raw.replace(/[$€£%\s]/g, '');
    token = /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(token) ? token.replace(/,/g, '') : token.replace(',', '.');
    const n = Number(token);
    if (Number.isFinite(n)) out.push(String(n));
  }
  return out;
}

function allowedNumbers(ctx: CriticContext): Set<string> {
  const allowed = new Set<string>();
  const add = (n: number) => {
    for (const d of [0, 1, 2]) allowed.add(String(Math.round(n * 10 ** d) / 10 ** d));
  };
  for (let i = 0; i <= 12; i += 1) allowed.add(String(i));
  for (const e of ctx.research.evidence) canonicalNumbers(e.snippet).forEach((n) => allowed.add(n));
  for (const m of ctx.metrics) if (m.value !== null) add(m.value);
  for (const text of [ctx.goal, ctx.company, ctx.url ?? '']) canonicalNumbers(text).forEach((n) => allowed.add(n));
  add(ctx.research.sources.length);
  add(ctx.research.sources.filter((s) => s.status === 'ok').length);
  add(ctx.research.evidence.length);
  return allowed;
}

function ungrounded(text: string, allowed: Set<string>): string[] {
  return [...new Set(canonicalNumbers(text).filter((n) => !allowed.has(n)))];
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/** Quoted source text is evidence, not the report's own wording; style checks ignore it. */
function unquoted(text: string): string {
  return text.replace(/"[^"]*"/g, '""');
}

const HEDGE_RE = /\b(?:might|may|could|likely|probably|suggests?|appears?)\b/i;
/** Judgements that are conclusions, not observations; they belong in inferences or risks, never in confirmed findings. */
const EVALUATIVE_RE = /\b(?:friction|barriers?|obstacles?|confusing|difficult|hard to|complex|complicated|slows?|hinders?|deters?|blocks? (?:buyers|users|conversion))\b/i;

type Verdict = Synthesis['hypothesisVerdicts'][number];

/**
 * Why a hypothesis verdict is invalid, or null. Rules:
 * - inconclusive carries no confidence;
 * - every cited id exists, is not cited both for and against, and relates to the hypothesis (its evidence
 *   categories) or to a confirmed finding;
 * - supported needs supporting evidence and none against (otherwise it is partially supported);
 * - partially_supported needs supporting evidence plus contradicting evidence, missing evidence or incomplete
 *   coverage, and at most medium confidence;
 * - refuted must cite the evidence that contradicts the hypothesis;
 * - coverage caps confidence, and no verdict other than inconclusive is allowed without relevant evidence.
 */
function verdictProblem(v: Verdict, h: HypothesisAssessment, unknownIds: (ids: string[]) => string[], related: Set<string>): string | null {
  const supporting = v.evidenceIds;
  const contradicting = v.contradictingEvidenceIds ?? [];
  const missing = v.missingEvidence ?? [];
  if (v.verdict === 'inconclusive') return v.confidence !== null ? `${v.id} is inconclusive but states a confidence` : null;
  const cited = [...supporting, ...contradicting];
  if (unknownIds(cited).length) return `${v.id} cites unknown evidence ${unknownIds(cited).join(', ')}`;
  const both = supporting.filter((id) => contradicting.includes(id));
  if (both.length) return `${v.id} cites ${both.join(', ')} both for and against the hypothesis`;
  const unrelated = cited.filter((id) => !related.has(id));
  if (unrelated.length) return `${v.id} cites ${unrelated.join(', ')}, which is neither evidence for this hypothesis nor cited by any confirmed finding`;
  if (h.coverage === 'none') return `${v.id} is marked ${v.verdict} although no relevant evidence was found`;
  if (v.verdict === 'supported') {
    if (supporting.length === 0) return `${v.id} is marked supported without valid supporting evidence`;
    if (contradicting.length) return `${v.id} is marked supported despite contradicting evidence ${contradicting.join(', ')}; use partially_supported`;
  }
  if (v.verdict === 'partially_supported') {
    if (supporting.length === 0) return `${v.id} is marked partially_supported without supporting evidence`;
    if (contradicting.length === 0 && missing.length === 0 && h.coverage === 'complete') {
      return `${v.id} is marked partially_supported but names no contradicting or missing evidence`;
    }
    if (v.confidence === 'high') return `${v.id} is partially_supported, so its confidence cannot be high`;
  }
  if (v.verdict === 'refuted' && contradicting.length === 0) return `${v.id} is marked refuted without citing contradicting evidence`;
  if (v.confidence === null) return `${v.id} is marked ${v.verdict} without a confidence level`;
  if (exceedsCap(v.confidence, h.maxVerdictConfidence)) {
    return `${v.id} claims ${v.confidence} confidence but its ${h.coverage} evidence coverage allows at most ${h.maxVerdictConfidence ?? 'none'}`;
  }
  return null;
}

/** Evidence a verdict may legitimately cite: the hypothesis' own category evidence plus anything a confirmed finding cites. */
function relatedEvidence(h: HypothesisAssessment, s: Synthesis): Set<string> {
  return new Set([...h.evidenceFound, ...s.confirmedFindings.flatMap((f) => f.evidenceIds)]);
}
const CAUSAL_CHURN_RE = /\b(?:causes?|caused|causing|drives?|driving|driven by|leads? to|results? in|is responsible for)\b[^.]{0,80}\bchurn\b|\bchurn\b[^.]{0,40}\b(?:is caused|is driven|because of|due to)\b/i;
const CHURN_FIGURE_RE = /\b(?:churn|cancellation|retention|renewal) rates?\b[^.]{0,40}\d/i;

function narrativeTexts(s: Synthesis): { label: string; text: string }[] {
  return [
    { label: 'executive summary', text: s.executiveSummary },
    { label: 'company profile', text: s.companyProfile },
    ...s.confirmedFindings.map((f, i) => ({ label: `finding ${i + 1}`, text: f.statement })),
    ...s.inferences.map((f, i) => ({ label: `inference ${i + 1}`, text: `${f.statement} ${f.reasoning}` })),
    ...s.risks.map((r, i) => ({ label: `risk ${i + 1}`, text: `${r.title} ${r.detail}` })),
    ...s.opportunities.map((r, i) => ({ label: `opportunity ${i + 1}`, text: `${r.title} ${r.detail}` })),
    ...s.hypothesisVerdicts.map((v) => ({ label: `verdict ${v.id}`, text: v.rationale })),
  ];
}

export function runDeterministicChecks(draft: ReportDraft, ctx: CriticContext): { checks: CriticCheck[]; issues: CriticIssue[] } {
  const checks: CriticCheck[] = [];
  const issues: CriticIssue[] = [];
  const { synthesis: s } = draft;
  const evidenceIds = new Set(ctx.research.evidence.map((e) => e.id));
  const unknownIds = (ids: string[]) => ids.filter((id) => !evidenceIds.has(id));
  const fail = (target: CriticIssue['target'], message: string) => issues.push({ severity: 'error', target, message });
  const warn = (target: CriticIssue['target'], message: string) => issues.push({ severity: 'warning', target, message });

  // C1 — sources actually retrieved
  const ok = ctx.research.sources.filter((src) => src.status === 'ok');
  const failed = ctx.research.sources.filter((src) => src.status !== 'ok');
  if (ok.length === 0) {
    checks.push({ id: 'C1', label: 'Sources retrieved', status: 'fail', detail: `No source was retrieved. ${ctx.research.statusReason}` });
    fail('retrieval', 'No public source could be retrieved; findings cannot be grounded.');
  } else {
    checks.push({
      id: 'C1',
      label: 'Sources retrieved',
      status: failed.length > 0 ? 'warn' : 'pass',
      detail: `${ok.length} retrieved, ${failed.length} failed/empty/blocked.`,
    });
  }

  // C2 — important claims cite retrieved evidence
  const c2: string[] = [];
  s.confirmedFindings.forEach((f, i) => {
    if (f.evidenceIds.length === 0) c2.push(`Finding ${i + 1} cites no evidence`);
    const bad = unknownIds(f.evidenceIds);
    if (bad.length) c2.push(`Finding ${i + 1} cites unknown evidence ${bad.join(', ')}`);
  });
  s.inferences.forEach((f, i) => {
    if (f.evidenceIds.length === 0) c2.push(`Inference ${i + 1} has no evidential basis`);
    const bad = unknownIds(f.evidenceIds);
    if (bad.length) c2.push(`Inference ${i + 1} cites unknown evidence ${bad.join(', ')}`);
  });
  [...s.risks, ...s.opportunities].forEach((r) => {
    const bad = unknownIds(r.evidenceIds);
    if (bad.length) c2.push(`"${r.title}" cites unknown evidence ${bad.join(', ')}`);
  });
  c2.forEach((m) => fail('synthesizer', m));
  checks.push({ id: 'C2', label: 'Claims backed by sources', status: c2.length ? 'fail' : 'pass', detail: c2.length ? c2.join('; ') : 'Every finding and inference cites retrieved evidence.' });

  // C3 — citations correspond to retrieved content
  const c3: string[] = [];
  for (const e of ctx.research.evidence) {
    const corpus = ctx.corpora[e.sourceId];
    if (!corpus) c3.push(`${e.id}: source ${e.sourceId} has no retrieved content`);
    else if (!corpus.includes(collapse(e.snippet))) c3.push(`${e.id}: snippet not found in ${e.sourceId}`);
  }
  c3.forEach((m) => fail('retrieval', m));
  checks.push({
    id: 'C3',
    label: 'Citations match retrieved content',
    status: c3.length ? 'fail' : ctx.research.evidence.length ? 'pass' : 'skipped',
    detail: c3.length ? c3.slice(0, 5).join('; ') : ctx.research.evidence.length ? `${ctx.research.evidence.length} snippets verified verbatim against fetched pages.` : 'No evidence to verify.',
  });

  // C4 — calculations reproduce independently
  const c4: string[] = [];
  for (const m of ctx.metrics) {
    const expected = ctx.reference.get(m.id);
    if (expected === undefined) continue;
    const same = expected === null ? m.value === null : m.value !== null && Math.abs(m.value - expected) < 0.011;
    if (!same) c4.push(`${m.id} sandbox=${m.value} reference=${expected}`);
    if ((m.status === 'ok') !== (m.value !== null)) c4.push(`${m.id} status inconsistent with value`);
  }
  c4.forEach((m) => fail('retrieval', `Calculation mismatch: ${m}`));
  checks.push({ id: 'C4', label: 'Calculations verified', status: c4.length ? 'fail' : 'pass', detail: c4.length ? c4.join('; ') : `${ctx.metrics.length} sandbox metrics match an independent re-computation.` });

  // C5 — facts are not confused with hypotheses
  const c5: string[] = [];
  for (const v of s.hypothesisVerdicts) {
    const h = draft.hypotheses.find((x) => x.id === v.id);
    if (!h) {
      c5.push(`Verdict for unknown hypothesis ${v.id}`);
      continue;
    }
    const problem = verdictProblem(v, h, unknownIds, relatedEvidence(h, s));
    if (problem) c5.push(problem);
  }
  s.confirmedFindings.forEach((f, i) => {
    if (HEDGE_RE.test(unquoted(f.statement))) c5.push(`Finding ${i + 1} is hedged; move it to inferences`);
    if (EVALUATIVE_RE.test(unquoted(f.statement))) c5.push(`Finding ${i + 1} states an evaluation (e.g. friction) as an observed fact; move it to inferences or risks`);
  });
  c5.forEach((m) => fail('synthesizer', m));
  checks.push({ id: 'C5', label: 'Facts separated from hypotheses', status: c5.length ? 'fail' : 'pass', detail: c5.length ? c5.join('; ') : 'Verdicts are evidence-backed and findings are stated as observed facts.' });

  // C6 — no invented numbers
  const allowed = allowedNumbers(ctx);
  const c6: string[] = [];
  for (const { label, text } of narrativeTexts(s)) {
    const bad = ungrounded(text, allowed);
    if (bad.length) c6.push(`${label}: ${bad.join(', ')}`);
  }
  const recWarn: string[] = [];
  s.recommendations.forEach((r, i) => {
    const bad = ungrounded(r.expectedImpact, allowed);
    if (bad.length) recWarn.push(`recommendation ${i + 1} impact: ${bad.join(', ')}`);
  });
  c6.forEach((m) => fail('synthesizer', `Number not found in sources or sandbox metrics — ${m}`));
  recWarn.forEach((m) => warn('synthesizer', `Unsourced target figure — ${m}`));
  checks.push({
    id: 'C6',
    label: 'No invented figures',
    status: c6.length ? 'fail' : recWarn.length ? 'warn' : 'pass',
    detail: c6.length ? c6.join('; ') : recWarn.length ? `Recommendation targets are estimates, not observations: ${recWarn.join('; ')}` : 'Every figure traces to a source snippet or a sandbox metric.',
  });

  // C7 — recommendations are actionable and tied to the investigation
  const c7: string[] = [];
  const hypothesisIds = new Set(draft.hypotheses.map((h) => h.id));
  s.recommendations.forEach((r, i) => {
    if (!hypothesisIds.has(r.hypothesisId)) c7.push(`Recommendation ${i + 1} references unknown hypothesis ${r.hypothesisId}`);
  });
  c7.forEach((m) => fail('synthesizer', m));
  checks.push({ id: 'C7', label: 'Recommendations tied to hypotheses', status: c7.length ? 'fail' : 'pass', detail: c7.length ? c7.join('; ') : `${s.recommendations.length} recommendations, each linked to a hypothesis with a KPI.` });

  // C8 — churn claims stay provisional and non-causal
  if (ctx.churnGoal) {
    const c8: string[] = [];
    if (draft.churn.status !== 'provisional') c8.push('Churn assessment must be provisional without internal data');
    for (const { label, text } of narrativeTexts(s)) {
      if (CAUSAL_CHURN_RE.test(unquoted(text))) c8.push(`${label} presents a causal churn claim`);
      if (CHURN_FIGURE_RE.test(unquoted(text))) c8.push(`${label} states a churn/retention figure not available from public sources`);
    }
    c8.forEach((m) => fail('synthesizer', m));
    checks.push({ id: 'C8', label: 'Churn diagnosis kept provisional', status: c8.length ? 'fail' : 'pass', detail: c8.length ? c8.join('; ') : 'Churn is treated as provisional and no causality is claimed.' });
  } else {
    checks.push({ id: 'C8', label: 'Churn diagnosis kept provisional', status: 'skipped', detail: 'Goal does not request a churn diagnosis.' });
  }

  return { checks, issues };
}

export function applyJudge(result: { checks: CriticCheck[]; issues: CriticIssue[] }, judge: CriticJudge | null): { checks: CriticCheck[]; issues: CriticIssue[] } {
  if (!judge) {
    return { checks: [...result.checks, { id: 'C9', label: 'LLM judge: goal fit & contradictions', status: 'skipped', detail: 'LLM judge unavailable; deterministic checks only.' }], issues: result.issues };
  }
  const problems = [
    ...(judge.goalAlignment === 'fail' ? [`Goal alignment: ${judge.goalAlignmentNote}`] : []),
    ...judge.contradictions.map((c) => `Contradiction: ${c}`),
    ...judge.factHypothesisConfusion.map((c) => `Fact/hypothesis confusion: ${c}`),
  ];
  return {
    checks: [
      ...result.checks,
      { id: 'C9', label: 'LLM judge: goal fit & contradictions', status: problems.length ? 'fail' : 'pass', detail: problems.length ? problems.join('; ') : judge.goalAlignmentNote || 'Recommendations address the goal; no contradictions found.' },
    ],
    issues: [...result.issues, ...problems.map((message) => ({ severity: 'error' as const, target: 'synthesizer' as const, message }))],
  };
}

export function summarizeCritic(result: { checks: CriticCheck[]; issues: CriticIssue[] }, researchStatus: ResearchResult['status'], llmJudge: CriticReport['llmJudge']): CriticReport {
  const fixableFailure = result.issues.some((i) => i.severity === 'error' && i.target === 'synthesizer');
  const anyProblem = result.checks.some((c) => c.status === 'fail' || c.status === 'warn');
  return {
    status: fixableFailure ? 'fail' : anyProblem || researchStatus !== 'live' ? 'pass_with_limitations' : 'pass',
    checks: result.checks,
    issues: result.issues,
    llmJudge,
  };
}

/**
 * Removes or replaces every report element that failed validation, falling back to deterministic text built from
 * retrieved evidence. Used when revision cycles are exhausted.
 */
export function repairDraft(draft: ReportDraft, ctx: CriticContext, baseline: Synthesis): { draft: ReportDraft; notes: string[] } {
  const notes: string[] = [];
  const evidenceIds = new Set(ctx.research.evidence.map((e) => e.id));
  const allowed = allowedNumbers(ctx);
  const valid = (ids: string[]) => ids.every((id) => evidenceIds.has(id));
  const grounded = (text: string) => ungrounded(text, allowed).length === 0;
  const churnSafe = (text: string) => !ctx.churnGoal || (!CAUSAL_CHURN_RE.test(unquoted(text)) && !CHURN_FIGURE_RE.test(unquoted(text)));
  const s = draft.synthesis;

  const keep = <T>(items: T[], ok: (item: T) => boolean, what: string): T[] => {
    const kept = items.filter(ok);
    if (kept.length < items.length) notes.push(`Removed ${items.length - kept.length} ${what} that failed validation.`);
    return kept;
  };
  const confirmedFindings = keep(
    s.confirmedFindings,
    (f) =>
      f.evidenceIds.length > 0 &&
      valid(f.evidenceIds) &&
      grounded(f.statement) &&
      churnSafe(f.statement) &&
      !HEDGE_RE.test(unquoted(f.statement)) &&
      !EVALUATIVE_RE.test(unquoted(f.statement)),
    'findings',
  );
  const inferences = keep(s.inferences, (f) => f.evidenceIds.length > 0 && valid(f.evidenceIds) && grounded(`${f.statement} ${f.reasoning}`) && churnSafe(f.statement), 'inferences');
  const risks = keep(s.risks, (r) => valid(r.evidenceIds) && grounded(`${r.title} ${r.detail}`) && churnSafe(r.detail), 'risks');
  const opportunities = keep(s.opportunities, (r) => valid(r.evidenceIds) && grounded(`${r.title} ${r.detail}`), 'opportunities');
  const hypothesisIds = new Set(draft.hypotheses.map((h) => h.id));
  let recommendations = keep(s.recommendations, (r) => hypothesisIds.has(r.hypothesisId), 'recommendations');
  if (recommendations.length === 0) recommendations = baseline.recommendations;

  const hypothesisVerdicts = s.hypothesisVerdicts
    .filter((v) => hypothesisIds.has(v.id))
    .map((v) => {
      const h = draft.hypotheses.find((x) => x.id === v.id);
      // Judged against the findings that survive repair, so a verdict cannot lean on a removed finding.
      const problem = h ? verdictProblem(v, h, (ids) => ids.filter((id) => !evidenceIds.has(id)), relatedEvidence(h, { ...s, confirmedFindings })) : 'unknown hypothesis';
      if (!problem && grounded(v.rationale)) return v;
      if (v.verdict === 'inconclusive') return { ...v, confidence: null };
      notes.push(`${v.id} verdict downgraded to inconclusive: ${problem ?? 'its rationale contained unverifiable figures'}.`);
      return {
        ...v,
        verdict: 'inconclusive' as const,
        confidence: null,
        rationale: 'Downgraded by the Critic: the proposed verdict was not supported by retrieved evidence.',
        evidenceIds: [],
        contradictingEvidenceIds: [],
      };
    });

  let { executiveSummary, companyProfile } = s;
  if (!grounded(executiveSummary) || !churnSafe(executiveSummary)) {
    executiveSummary = baseline.executiveSummary;
    notes.push('Executive summary replaced with the evidence-only version because it contained unverifiable figures or causal churn claims.');
  }
  if (!grounded(companyProfile)) {
    companyProfile = baseline.companyProfile;
    notes.push('Company profile replaced with the evidence-only version because it contained unverifiable figures.');
  }

  return {
    draft: { ...draft, synthesis: { ...s, executiveSummary, companyProfile, confirmedFindings, inferences, risks, opportunities, recommendations, hypothesisVerdicts } },
    notes,
  };
}
