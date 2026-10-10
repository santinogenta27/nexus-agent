import { z } from 'zod';

export const NODE_IDS = ['planner', 'retrieval', 'sandbox', 'synthesizer', 'critic'] as const;
export const NodeIdSchema = z.enum(NODE_IDS);
export type NodeId = z.infer<typeof NodeIdSchema>;

export const DOMAINS = ['saas', 'fintech', 'developer-tools', 'ecommerce', 'ai-infra', 'general'] as const;
export const DomainSchema = z.enum(DOMAINS);
export type Domain = z.infer<typeof DomainSchema>;

/** Maximum critic → synthesizer revision cycles. */
export const MAX_CYCLES = 3;

export const AgentRunRequestSchema = z
  .object({
    goal: z.string().trim().min(10, 'Goal must be at least 10 characters').max(2000),
    company: z.string().trim().max(120).optional(),
    url: z.string().trim().max(2048).optional(),
    domain: DomainSchema.default('general'),
    depth: z.number().int().min(1).max(MAX_CYCLES).default(2),
  })
  .refine((v) => Boolean(v.company) || Boolean(v.url), { message: 'Provide a company name or a public URL', path: ['company'] });
export type AgentRunRequest = z.infer<typeof AgentRunRequestSchema>;

// ---------------------------------------------------------------------------
// Research: sources and evidence
// ---------------------------------------------------------------------------

export const PAGE_KINDS = ['home', 'pricing', 'product', 'docs', 'customers', 'other'] as const;
export type PageKind = (typeof PAGE_KINDS)[number];

export type SourceStatus = 'ok' | 'empty' | 'failed' | 'blocked';

export interface SourceRecord {
  id: string;
  url: string;
  finalUrl?: string;
  kind: PageKind;
  status: SourceStatus;
  httpStatus?: number;
  title?: string;
  bytes: number;
  textChars: number;
  durationMs: number;
  error?: string;
}

export const EVIDENCE_KINDS = ['value_prop', 'feature', 'audience', 'pricing', 'custom_pricing', 'friction', 'docs'] as const;
export const EvidenceKindSchema = z.enum(EVIDENCE_KINDS);
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;

export const FRICTION_SIGNALS = [
  'contact_sales',
  'demo_required',
  'free_trial',
  'free_plan',
  'no_credit_card',
  'self_serve_signup',
  'annual_commitment',
  'setup_fee',
  'usage_limits',
] as const;
export type FrictionSignal = (typeof FRICTION_SIGNALS)[number];

export interface Evidence {
  id: string;
  sourceId: string;
  url: string;
  kind: EvidenceKind;
  /** Verbatim text extracted from the retrieved page (whitespace-normalised). */
  snippet: string;
  signal?: FrictionSignal;
  /** Nearest page heading (product or section) the snippet sits under, verbatim. */
  context?: string;
  /**
   * Friction evidence only: true when the phrase is tied to a plan, price or product (e.g. "Custom pricing …
   * Contact sales"); false for generic call-to-action buttons such as "Start now Contact sales".
   */
  contextual?: boolean;
}

const Currency = z.enum(['USD', 'EUR', 'GBP']);

/** One published price. Fields not stated next to the price on the page are null — never inferred. */
export const PriceObservationSchema = z.object({
  evidenceId: z.string(),
  amount: z.number().finite().nonnegative(),
  currency: Currency,
  /** Product or section heading the price is published under. */
  product: z.string().max(100).nullable(),
  /** Line item named next to the price, e.g. "Dispute received fee". */
  item: z.string().max(80).nullable(),
  /** Billing unit stated with the price, e.g. "user", "successful transaction for domestic cards". */
  unit: z.string().max(80).nullable(),
  period: z.enum(['month', 'year']).nullable(),
  /** Stated conditions, e.g. "Starting at", "1-year contract", "billed annually". */
  terms: z.array(z.string().max(60)).max(4),
});
export type PriceObservation = z.infer<typeof PriceObservationSchema>;

export const PercentFeeSchema = z.object({
  evidenceId: z.string(),
  percent: z.number().finite().positive().max(100),
  fixedAmount: z.number().finite().nonnegative().nullable(),
  fixedCurrency: Currency.nullable(),
  product: z.string().max(100).nullable(),
  item: z.string().max(80).nullable(),
  unit: z.string().max(80).nullable(),
});
export type PercentFee = z.infer<typeof PercentFeeSchema>;

export type ResolutionMethod = 'user_url' | 'llm_suggestion_verified' | 'domain_heuristic_verified' | 'unresolved';

export interface ResearchTarget {
  company: string;
  url: string | null;
  resolvedBy: ResolutionMethod;
  candidatesTried: { url: string; outcome: string }[];
}

export type ResearchStatus = 'live' | 'partial' | 'fallback';

export interface ResearchResult {
  target: ResearchTarget;
  status: ResearchStatus;
  statusReason: string;
  sources: SourceRecord[];
  evidence: Evidence[];
  prices: PriceObservation[];
  percentFees: PercentFee[];
  /** Price tokens found on pricing pages but discarded because no product or rate could be linked to them. */
  discardedPriceFragments: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Supervisor: deductive hypotheses
// ---------------------------------------------------------------------------

export const HYPOTHESIS_AREAS = ['product', 'pricing', 'friction'] as const;
export const HypothesisAreaSchema = z.enum(HYPOTHESIS_AREAS);
export type HypothesisArea = z.infer<typeof HypothesisAreaSchema>;

export const HypothesisDraftSchema = z.object({
  area: HypothesisAreaSchema,
  statement: z.string().min(10).max(400),
  evidenceNeeded: z.array(z.string().min(3).max(200)).min(1).max(5),
  refutedBy: z.string().min(5).max(300),
});
export type HypothesisDraft = z.infer<typeof HypothesisDraftSchema>;

/** Shape the Supervisor LLM must return. */
export const SupervisorOutputSchema = z.object({
  hypotheses: z.array(HypothesisDraftSchema).length(3),
  officialDomainGuess: z.string().max(253).nullable(),
  researchFocus: z.string().min(5).max(300),
});
export type SupervisorOutput = z.infer<typeof SupervisorOutputSchema>;

/** How much of the evidence a hypothesis needs was observed. Says nothing about whether the hypothesis is true. */
export type EvidenceCoverage = 'none' | 'low' | 'partial' | 'complete';
/** Confidence in a supported/refuted verdict. Always null when the verdict is inconclusive. */
export type VerdictConfidence = 'low' | 'medium' | 'high';
export type HypothesisVerdict = 'supported' | 'refuted' | 'inconclusive';

export interface HypothesisAssessment extends HypothesisDraft {
  id: string;
  /** Deterministic coverage of the evidence categories this area requires. */
  requiredCategories: string[];
  categoriesFound: string[];
  categoriesMissing: string[];
  evidenceFound: string[];
  coverage: EvidenceCoverage;
  coverageJustification: string;
  /** Highest verdict confidence the coverage and research status allow. */
  maxVerdictConfidence: VerdictConfidence | null;
  verdict: HypothesisVerdict;
  verdictConfidence: VerdictConfidence | null;
  verdictRationale: string;
  verdictEvidence: string[];
}

// ---------------------------------------------------------------------------
// Sandbox: verifiable metrics
// ---------------------------------------------------------------------------

export interface MetricResult {
  id: string;
  label: string;
  kind: 'observed' | 'calculated';
  status: 'ok' | 'insufficient_data';
  value: number | null;
  unit: string;
  formula: string;
  inputs: string[];
  note: string;
}

export interface SandboxResult {
  language: 'javascript';
  code: string;
  stdout: string;
  metrics: MetricResult[];
  rejectedInputs: string[];
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Synthesizer: intelligence report
// ---------------------------------------------------------------------------

const EvidenceIds = z.array(z.string().max(12)).max(12);

/** Shape the Synthesizer LLM must return. Lists of evidence, prices and sources are attached by code. */
export const SynthesisSchema = z.object({
  executiveSummary: z.string().min(1).max(1800),
  companyProfile: z.string().min(1).max(1200),
  confirmedFindings: z.array(z.object({ statement: z.string().min(1).max(400), evidenceIds: EvidenceIds })).max(12),
  inferences: z
    .array(z.object({ statement: z.string().min(1).max(400), reasoning: z.string().min(1).max(400), evidenceIds: EvidenceIds }))
    .max(8),
  openQuestions: z.array(z.string().min(1).max(300)).max(8),
  hypothesisVerdicts: z
    .array(
      z.object({
        id: z.string(),
        verdict: z.enum(['supported', 'refuted', 'inconclusive']),
        /** Required for supported/refuted; must be null for inconclusive. */
        confidence: z.enum(['low', 'medium', 'high']).nullable(),
        rationale: z.string().min(1).max(400),
        evidenceIds: EvidenceIds,
      }),
    )
    .max(3),
  risks: z
    .array(z.object({ title: z.string().min(1).max(120), detail: z.string().min(1).max(400), priority: z.enum(['P0', 'P1', 'P2']), evidenceIds: EvidenceIds }))
    .max(6),
  opportunities: z
    .array(z.object({ title: z.string().min(1).max(120), detail: z.string().min(1).max(400), priority: z.enum(['P0', 'P1', 'P2']), evidenceIds: EvidenceIds }))
    .max(6),
  recommendations: z
    .array(
      z.object({
        action: z.string().min(1).max(300),
        expectedImpact: z.string().min(1).max(300),
        effort: z.enum(['low', 'medium', 'high']),
        timeframe: z.string().min(1).max(60),
        kpi: z.string().min(1).max(160),
        hypothesisId: z.string(),
      }),
    )
    .min(1)
    .max(6),
});
export type Synthesis = z.infer<typeof SynthesisSchema>;

export interface ChurnAssessment {
  status: 'not_requested' | 'provisional';
  note: string;
}

export interface IntelligenceReport extends Synthesis {
  company: ResearchTarget;
  researchStatus: ResearchStatus;
  hypotheses: HypothesisAssessment[];
  pricing: PriceObservation[];
  percentFees: PercentFee[];
  metrics: MetricResult[];
  evidence: Evidence[];
  sources: (SourceRecord & { supports: string[] })[];
  churn: ChurnAssessment;
  limitations: string[];
  codeArtifact: string;
}

// ---------------------------------------------------------------------------
// Critic: validation
// ---------------------------------------------------------------------------

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skipped';

export interface CriticCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface CriticIssue {
  severity: 'error' | 'warning';
  target: 'synthesizer' | 'supervisor' | 'retrieval';
  message: string;
}

export interface CriticReport {
  status: 'pass' | 'pass_with_limitations' | 'fail';
  checks: CriticCheck[];
  issues: CriticIssue[];
  /** 'live' only when the Gemini judge actually ran; otherwise only deterministic rule checks were applied. */
  llmJudge: 'live' | 'unavailable';
  llmJudgeUnavailableReason?: string;
  llmJudgeFailureKind?: LlmFailureKind;
}

/** Shape the Critic LLM judge must return. */
export const CriticJudgeSchema = z.object({
  goalAlignment: z.enum(['pass', 'fail']),
  goalAlignmentNote: z.string().max(400),
  contradictions: z.array(z.string().max(300)).max(8),
  factHypothesisConfusion: z.array(z.string().max(300)).max(8),
});
export type CriticJudge = z.infer<typeof CriticJudgeSchema>;

// ---------------------------------------------------------------------------
// Traces, telemetry and API
// ---------------------------------------------------------------------------

export type ExecutionMode = 'live' | 'fallback';

/** Why an LLM step could not use Gemini. 'quota' means Gemini answered HTTP 429 RESOURCE_EXHAUSTED. */
export type LlmFailureKind = 'quota' | 'rate_guard' | 'timeout' | 'budget' | 'not_configured' | 'invalid_output' | 'skipped' | 'error';

export interface NodeTrace {
  id: string;
  node: NodeId;
  cycle: number;
  mode: ExecutionMode;
  startOffsetMs: number;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  summary: string;
  detail: unknown;
  fallbackReason?: string;
  fallbackKind?: LlmFailureKind;
}

export interface GeminiStatus {
  /** live: every LLM step answered; partial: some did; unavailable: none did; not_configured: no key. */
  status: 'live' | 'partial' | 'unavailable' | 'not_configured';
  quotaExhausted: boolean;
  failures: { node: NodeId; cycle: number; kind: LlmFailureKind; message: string }[];
}

export interface PlanStep {
  id: string;
  node: NodeId;
  title: string;
  dependsOn: string[];
}

export interface Telemetry {
  model: string;
  llmMode: ExecutionMode | 'hybrid';
  researchStatus: ResearchStatus;
  totalLatencyMs: number;
  p95LatencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  cycles: number;
  maxCycles: number;
  llmCalls: number;
  sourcesOk: number;
  sourcesFailed: number;
  gemini: GeminiStatus;
}

export interface AgentRunResponse {
  runId: string;
  goal: string;
  domain: Domain;
  plan: PlanStep[];
  traces: NodeTrace[];
  report: IntelligenceReport;
  critic: CriticReport;
  telemetry: Telemetry;
  warnings: string[];
}

export type AgentStreamEvent =
  | { type: 'plan'; plan: PlanStep[] }
  | { type: 'trace'; trace: NodeTrace }
  | { type: 'result'; result: AgentRunResponse }
  | { type: 'error'; message: string };

export interface HealthResponse {
  status: 'ok';
  uptimeSec: number;
  gemini: { configured: boolean; model: string };
  genkit: { initialized: boolean; cliInstalled: boolean; tools: string[]; flows: string[] };
  rateLimit: { rpm: number; usedLastMinute: number };
  research: { maxPages: number; budgetMs: number; perRequestTimeoutMs: number; maxBytes: number };
}
