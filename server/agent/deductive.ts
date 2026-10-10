import type {
  ChurnAssessment,
  Domain,
  Evidence,
  EvidenceCoverage,
  FrictionSignal,
  HypothesisArea,
  HypothesisAssessment,
  HypothesisDraft,
  MetricResult,
  ResearchResult,
  Synthesis,
  VerdictConfidence,
} from '../../src/types/agent.ts';

const CHURN_RE = /\b(churn|retention|retain|cancel+ations?|renewals?|attrition|abandon|abandono|cancelaci[oó]n|retenci[oó]n|bajas)\b/i;

export function isChurnGoal(goal: string): boolean {
  return CHURN_RE.test(goal);
}

export function churnAssessment(goal: string): ChurnAssessment {
  return isChurnGoal(goal)
    ? {
        status: 'provisional',
        note: 'Provisional only: no internal customer, usage, renewal or cancellation data was available. Public friction and pricing signals can suggest churn risks but cannot confirm churn drivers or rates.',
      }
    : { status: 'not_requested', note: 'The goal does not ask for a churn diagnosis.' };
}

const SEGMENT: Record<Domain, string> = {
  saas: 'business software buyers',
  fintech: 'businesses that move money online',
  'developer-tools': 'developers and engineering teams',
  ecommerce: 'online merchants and shoppers',
  'ai-infra': 'teams building AI products',
  general: 'its target customers',
};

/** Deterministic hypotheses used when the Supervisor LLM is unavailable. Phrased as testable claims, not facts. */
export function defaultHypotheses(company: string, goal: string, domain: Domain): HypothesisDraft[] {
  const churn = isChurnGoal(goal);
  return [
    {
      area: 'product',
      statement: `${company} communicates a clear value proposition and feature set for ${SEGMENT[domain]}, relevant to the goal: "${goal.slice(0, 120)}".`,
      evidenceNeeded: ['Headline value proposition', 'Concrete product features', 'Named customer segments', 'Documentation or product depth'],
      refutedBy: 'Public pages that are vague about what the product does or who it is for.',
    },
    {
      area: 'pricing',
      statement: `${company}'s published pricing is transparent enough for self-serve evaluation, with price levels that match the value it communicates.`,
      evidenceNeeded: ['Published prices or fees', 'Custom or sales-assisted pricing terms', 'Computable price levels'],
      refutedBy: 'A pricing page with no published prices, or pricing gated entirely behind sales.',
    },
    {
      area: 'friction',
      statement: `${company}'s path from first visit to adoption may contain friction (plan-level sales steps, commitments, limits) that could slow conversion${churn ? ' and raise early-life churn risk' : ''}.`,
      evidenceNeeded: ['Self-serve entry path', 'Plan-linked sales or demo step', 'Commitments, fees or usage limits'],
      refutedBy: 'A free or trial self-serve signup with no plan-level sales step, commitment or setup fee.',
    },
  ];
}

interface Category {
  id: string;
  label: string;
  find: (evidence: Evidence[], metrics: MetricResult[]) => string[];
}

const kinds = (...k: Evidence['kind'][]) => (evidence: Evidence[]) => evidence.filter((e) => k.includes(e.kind)).map((e) => e.id);
/** Friction signals that are tied to a plan, price or product. Generic CTA buttons never count. */
const contextualSignals = (...s: FrictionSignal[]) => (evidence: Evidence[]) =>
  evidence.filter((e) => e.signal && s.includes(e.signal) && e.contextual !== false).map((e) => e.id);
const anySignals = (...s: FrictionSignal[]) => (evidence: Evidence[]) => evidence.filter((e) => e.signal && s.includes(e.signal)).map((e) => e.id);

export const REQUIRED_CATEGORIES: Record<HypothesisArea, Category[]> = {
  product: [
    { id: 'value_prop', label: 'Stated value proposition', find: kinds('value_prop') },
    { id: 'features', label: 'Product features', find: kinds('feature') },
    { id: 'audience', label: 'Target customer segments', find: kinds('audience') },
    { id: 'docs', label: 'Documentation or product depth', find: kinds('docs') },
  ],
  pricing: [
    { id: 'published_prices', label: 'Published prices or fees linked to a product', find: kinds('pricing') },
    { id: 'sales_gated', label: 'Custom or plan-linked sales pricing terms', find: (e) => [...kinds('custom_pricing')(e), ...contextualSignals('contact_sales')(e)] },
    { id: 'price_levels', label: 'Computable recurring price levels (sandbox)', find: (_e, m) => m.find((x) => x.id === 'M2' && x.status === 'ok')?.inputs ?? [] },
  ],
  friction: [
    { id: 'entry_path', label: 'Self-serve entry path (signup, trial, free plan)', find: anySignals('self_serve_signup', 'free_trial', 'free_plan', 'no_credit_card') },
    { id: 'sales_gate', label: 'Plan-linked sales or demo step', find: contextualSignals('contact_sales', 'demo_required') },
    { id: 'commitment', label: 'Commitments, fees or usage limits', find: contextualSignals('annual_commitment', 'setup_fee', 'usage_limits') },
  ],
};

export function evidenceCoverage(found: number, required: number): EvidenceCoverage {
  if (found === 0) return 'none';
  const ratio = found / required;
  return ratio < 0.5 ? 'low' : ratio < 1 ? 'partial' : 'complete';
}

/**
 * Highest confidence a supported/refuted verdict may claim. Coverage measures how much evidence exists, not whether
 * the hypothesis is true, so it only caps confidence; it never sets it.
 */
export function maxVerdictConfidence(coverage: EvidenceCoverage, research: ResearchResult['status']): VerdictConfidence | null {
  if (research === 'fallback' || coverage === 'none') return null;
  const cap: VerdictConfidence = coverage === 'low' ? 'low' : coverage === 'partial' ? 'medium' : 'high';
  return research === 'partial' && cap === 'high' ? 'medium' : cap;
}

const RANK: Record<VerdictConfidence, number> = { low: 1, medium: 2, high: 3 };

export function exceedsCap(confidence: VerdictConfidence | null, cap: VerdictConfidence | null): boolean {
  if (confidence === null) return false;
  return cap === null || RANK[confidence] > RANK[cap];
}

export function assessHypotheses(drafts: HypothesisDraft[], research: ResearchResult, metrics: MetricResult[]): HypothesisAssessment[] {
  return drafts.map((draft, index) => {
    const categories = REQUIRED_CATEGORIES[draft.area];
    const found: string[] = [];
    const missing: string[] = [];
    const evidenceIds = new Set<string>();
    for (const category of categories) {
      const ids = category.find(research.evidence, metrics);
      if (ids.length > 0) {
        found.push(category.label);
        ids.forEach((id) => evidenceIds.add(id));
      } else missing.push(category.label);
    }
    const coverage = research.status === 'fallback' ? 'none' : evidenceCoverage(found.length, categories.length);
    const justification =
      research.status === 'fallback'
        ? 'No sources were retrieved, so the hypothesis is untested.'
        : `${found.length} of ${categories.length} evidence categories observed (${evidenceIds.size} items). Coverage says how much relevant evidence exists, not whether the hypothesis is true; missing categories may be absent or simply not on the retrieved pages.`;
    return {
      ...draft,
      id: `H${index + 1}`,
      requiredCategories: categories.map((c) => c.label),
      categoriesFound: found,
      categoriesMissing: missing,
      evidenceFound: [...evidenceIds].slice(0, 12),
      coverage,
      coverageJustification: justification,
      maxVerdictConfidence: maxVerdictConfidence(coverage, research.status),
      verdict: 'inconclusive',
      verdictConfidence: null,
      verdictRationale: 'Not yet evaluated.',
      verdictEvidence: [],
    };
  });
}

/** Applies the Synthesizer's verdicts to the assessed hypotheses. Validity is checked by the Critic. */
export function applyVerdicts(hypotheses: HypothesisAssessment[], verdicts: Synthesis['hypothesisVerdicts']): HypothesisAssessment[] {
  return hypotheses.map((h) => {
    const v = verdicts.find((x) => x.id === h.id);
    if (!v) return { ...h, verdict: 'inconclusive', verdictConfidence: null, verdictRationale: 'No verdict was produced.', verdictEvidence: [] };
    return {
      ...h,
      verdict: v.verdict,
      // An inconclusive verdict carries no confidence, whatever the model returned.
      verdictConfidence: v.verdict === 'inconclusive' ? null : v.confidence,
      verdictRationale: v.rationale,
      verdictEvidence: v.evidenceIds,
    };
  });
}

const SIGNAL_LABEL: Record<FrictionSignal, string> = {
  contact_sales: 'Contact sales',
  demo_required: 'Demo request',
  free_trial: 'Free trial',
  free_plan: 'Free plan',
  no_credit_card: 'No credit card required',
  self_serve_signup: 'Self-serve signup',
  annual_commitment: 'Annual billing or commitment',
  setup_fee: 'Setup or implementation fee',
  usage_limits: 'Usage limits',
};

export function signalLabel(signal: FrictionSignal): string {
  return SIGNAL_LABEL[signal];
}

function metricValue(metrics: MetricResult[], id: string): MetricResult | undefined {
  return metrics.find((m) => m.id === id && m.status === 'ok');
}

/**
 * Report narrative built only from retrieved evidence and sandbox metrics. Used when the Synthesizer LLM is
 * unavailable, and as the repair baseline when LLM output fails validation. Confirmed findings quote observations;
 * anything evaluative (friction, risk, opportunity) is stated as a hypothesis to verify.
 */
export function deterministicSynthesis(args: {
  company: string;
  url: string | null;
  goal: string;
  research: ResearchResult;
  hypotheses: HypothesisAssessment[];
  metrics: MetricResult[];
}): Synthesis {
  const { company, url, goal, research, hypotheses, metrics } = args;
  const ev = (kind: Evidence['kind']) => research.evidence.filter((e) => e.kind === kind);
  const okSources = research.sources.filter((s) => s.status === 'ok');
  const churn = isChurnGoal(goal);
  const coverageLine = hypotheses.map((h) => `${h.id} ${h.area}: ${h.coverage} evidence coverage`).join('; ');

  if (research.status === 'fallback') {
    return {
      executiveSummary: `No public source for ${company} could be retrieved and parsed (${research.statusReason}). No findings are reported and every hypothesis remains untested. Provide a reachable public URL to run live research.`,
      companyProfile: `No verified profile is available for ${company}: none of its public pages could be retrieved.`,
      confirmedFindings: [],
      inferences: [],
      openQuestions: [`What is ${company}'s official website?`, 'Which public pages describe its products and pricing?'],
      hypothesisVerdicts: hypotheses.map((h) => ({ id: h.id, verdict: 'inconclusive', confidence: null, rationale: 'Untested: no sources were retrieved.', evidenceIds: [] })),
      risks: [],
      opportunities: [],
      recommendations: [
        {
          action: `Re-run the research with ${company}'s official URL so its public pages can be retrieved.`,
          expectedImpact: 'Turns untested hypotheses into evidence-backed findings.',
          effort: 'low',
          timeframe: 'Immediate',
          kpi: 'Sources retrieved successfully',
          hypothesisId: 'H1',
        },
      ],
    };
  }

  const valueProps = ev('value_prop');
  const pricing = ev('pricing');
  const custom = ev('custom_pricing');
  const friction = ev('friction');
  const audience = ev('audience');
  const docs = ev('docs');
  const m1 = metricValue(metrics, 'M1');
  const m2 = metricValue(metrics, 'M2');
  const m3 = metricValue(metrics, 'M3');
  const m6 = metricValue(metrics, 'M6');
  const contextual = (s: FrictionSignal) => friction.filter((f) => f.signal === s && f.contextual !== false);
  const ctaOnly = friction.filter((f) => (f.signal === 'contact_sales' || f.signal === 'demo_required') && f.contextual === false);

  // Observed facts only: quotes and counts, no evaluation.
  const confirmedFindings: Synthesis['confirmedFindings'] = [];
  for (const v of valueProps.slice(0, 2)) confirmedFindings.push({ statement: `${company} describes itself as: "${v.snippet}"`, evidenceIds: [v.id] });
  for (const a of audience.slice(0, 1)) confirmedFindings.push({ statement: `Audience language on the site: "${a.snippet}"`, evidenceIds: [a.id] });
  if (m1 && m1.value !== null && m1.value > 0) {
    confirmedFindings.push({ statement: `The retrieved pricing pages publish ${m1.value} prices linked to a named product or rate.`, evidenceIds: m1.inputs.slice(0, 6) });
  }
  if (m6) {
    const fee = pricing.find((p) => p.id === m6.inputs[0]);
    if (fee) confirmedFindings.push({ statement: `${fee.context ? `Under "${fee.context}", the` : 'The'} pricing page lists: "${fee.snippet}"`, evidenceIds: [fee.id] });
  }
  for (const c of custom.slice(0, 1)) confirmedFindings.push({ statement: `The pricing page mentions custom or volume terms: "${c.snippet}"`, evidenceIds: [c.id] });
  for (const f of friction.filter((x) => x.contextual !== false).slice(0, 4)) {
    if (f.signal) confirmedFindings.push({ statement: `${signalLabel(f.signal)} phrase observed: "${f.snippet}"`, evidenceIds: [f.id] });
  }

  const selfServe = [...contextual('self_serve_signup'), ...contextual('free_trial'), ...contextual('free_plan'), ...contextual('no_credit_card')];
  const planSalesSteps = [...contextual('contact_sales'), ...contextual('demo_required')];
  const commitments = [...contextual('annual_commitment'), ...contextual('setup_fee')];

  // Inferences are unverified: each names the evidence it rests on and what it cannot show.
  const inferences: Synthesis['inferences'] = [];
  if (selfServe.length > 0 && (planSalesSteps.length > 0 || custom.length > 0)) {
    const gate = planSalesSteps[0] ?? custom[0];
    inferences.push({
      statement: `Hypothesis: ${company} combines self-serve entry with sales-assisted terms for some products or volumes.`,
      reasoning: 'Self-serve signup language and plan- or price-linked sales/custom-pricing language both appear on retrieved pages. This does not show how many buyers need the sales path.',
      evidenceIds: [selfServe[0].id, gate.id],
    });
  }
  if (docs.length > 0) {
    inferences.push({
      statement: 'Hypothesis: public documentation supports a developer-led evaluation path.',
      reasoning: 'A documentation page was retrieved from the official site; whether evaluators rely on it is not observable here.',
      evidenceIds: [docs[0].id],
    });
  }

  const openQuestions = hypotheses.flatMap((h) => h.categoriesMissing.map((c) => `${h.id} (${h.area}): no evidence found for "${c}" on the retrieved pages.`)).slice(0, 6);
  if (ctaOnly.length > 0) openQuestions.push(`Generic "${signalLabel(ctaOnly[0].signal ?? 'contact_sales')}" buttons were seen but are not tied to a plan; whether any tier requires a sales step is unresolved.`);
  if (churn) openQuestions.unshift('What are the actual churn, renewal and cancellation rates? This requires internal customer data that public pages do not contain.');

  // Risks and opportunities are potential effects, stated as hypotheses with their supporting observation.
  const risks: Synthesis['risks'] = [];
  if (planSalesSteps.length > 0) {
    risks.push({ title: 'Possible sales step for some offerings (unverified)', detail: 'A sales or demo step is tied to specific pricing on the page; its effect on conversion is not observed.', priority: 'P2', evidenceIds: [planSalesSteps[0].id] });
  }
  if (m1 && m1.value === 0) {
    risks.push({ title: 'No linked prices found (unverified impact)', detail: 'The retrieved pricing page had no price that could be tied to a product or rate; buyers may find evaluation harder.', priority: 'P1', evidenceIds: [] });
  }
  if (commitments.length > 0) {
    risks.push({ title: 'Possible upfront commitment (unverified)', detail: 'A commitment or setup fee is stated for at least one offering; how many buyers it affects is unknown.', priority: 'P2', evidenceIds: [commitments[0].id] });
  }

  const opportunities: Synthesis['opportunities'] = [];
  if (selfServe.length > 0) opportunities.push({ title: 'Self-serve entry point (unverified effect)', detail: 'Self-serve signup, trial or free-plan language suggests a low-barrier first step.', priority: 'P2', evidenceIds: [selfServe[0].id] });
  if (docs.length > 0) opportunities.push({ title: 'Documentation-led adoption (unverified effect)', detail: 'Public docs may let technical evaluators validate fit before talking to sales.', priority: 'P2', evidenceIds: [docs[0].id] });

  const priceRange =
    m2 && m3
      ? ` Recurring prices sharing one billing unit range from ${m2.value} to ${m3.value} ${m2.unit}${/different products/.test(m2.note) ? ', across different products rather than one plan ladder' : ''}.`
      : '';
  return {
    executiveSummary: `Research covered ${okSources.length} public pages of ${company}${url ? ` (${url})` : ''}. ${
      valueProps[0] ? `Its stated positioning: "${valueProps[0].snippet}".` : 'No headline value proposition was extracted.'
    }${m1 && m1.value !== null ? ` The pricing pages publish ${m1.value} prices linked to a product or rate.` : ' No pricing page was retrieved.'}${priceRange} Evidence coverage: ${coverageLine}. All hypotheses remain inconclusive: coverage shows what evidence exists, not whether a hypothesis holds.${
      churn ? ' Any churn reading here is provisional: public signals cannot confirm churn drivers.' : ''
    } This report was assembled deterministically from retrieved text without LLM synthesis.`,
    companyProfile: `${company}${url ? ` (${url})` : ''}. ${valueProps.map((v) => `"${v.snippet}"`).join(' ') || 'No value proposition text was extracted.'}${
      audience[0] ? ` Audience signal: "${audience[0].snippet}".` : ''
    }`,
    confirmedFindings: confirmedFindings.slice(0, 12),
    inferences,
    openQuestions: openQuestions.slice(0, 8),
    hypothesisVerdicts: hypotheses.map((h) => ({
      id: h.id,
      verdict: 'inconclusive',
      confidence: null,
      rationale: `Not evaluated: the deterministic engine measures evidence coverage (${h.coverage}) only; supporting or refuting the hypothesis needs LLM or analyst review.`,
      evidenceIds: h.evidenceFound.slice(0, 6),
    })),
    risks,
    opportunities,
    recommendations: hypotheses.map((h) => ({
      action:
        h.categoriesMissing.length > 0
          ? `Close the evidence gap for ${h.id} (${h.area}): collect ${h.categoriesMissing.join(', ').toLowerCase()}.`
          : `Review ${h.id} (${h.area}) against the cited evidence and decide whether it holds for the goal.`,
      expectedImpact: `Moves ${h.id} from an inconclusive verdict towards a decision-ready conclusion.`,
      effort: h.categoriesMissing.length > 1 ? 'medium' : 'low',
      timeframe: '1–2 weeks',
      kpi: h.area === 'pricing' ? 'Pricing evidence coverage' : h.area === 'friction' ? 'Visit-to-signup conversion (internal)' : 'Positioning evidence coverage',
      hypothesisId: h.id,
    })),
  };
}
