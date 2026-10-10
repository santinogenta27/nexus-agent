import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { ApiError, GoogleGenAI } from '@google/genai';
import { genkit } from 'genkit';
import { googleAI } from '@genkit-ai/google-genai';
import { z } from 'zod';
import { AgentRunRequestSchema, CriticJudgeSchema, MAX_CYCLES, SupervisorOutputSchema, SynthesisSchema } from './src/types/agent.ts';
import type {
  AgentRunRequest,
  AgentRunResponse,
  AgentStreamEvent,
  CriticJudge,
  CriticReport,
  ExecutionMode,
  GeminiStatus,
  HealthResponse,
  HypothesisAssessment,
  IntelligenceReport,
  LlmFailureKind,
  NodeId,
  NodeTrace,
  PlanStep,
  ResearchResult,
  SandboxResult,
  SupervisorOutput,
  Synthesis,
  Telemetry,
} from './src/types/agent.ts';
import { RESEARCH_DEFAULTS, researchCompany } from './server/research/retrieve.ts';
import type { ResearchOutput } from './server/research/retrieve.ts';
import { executeSandbox, referenceMetrics } from './server/analysis/sandbox.ts';
import type { SandboxInput } from './server/analysis/sandbox.ts';
import { applyJudge, repairDraft, runDeterministicChecks, summarizeCritic } from './server/analysis/critic.ts';
import type { CriticContext, ReportDraft } from './server/analysis/critic.ts';
import { applyVerdicts, assessHypotheses, churnAssessment, defaultHypotheses, deterministicSynthesis, isChurnGoal } from './server/agent/deductive.ts';
import { LlmUnavailableError, classifyLlmError, failureLabel } from './server/agent/llmErrors.ts';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY?.trim() || undefined;
const GEMINI_MODEL = process.env.GEMINI_MODEL?.trim() || 'gemini-3.8-flash';
// Transient Gemini errors (500 / 503 "high demand") are retried with exponential backoff: 2 s, then 4 s.
const LLM_MAX_RETRIES = 2;
const LLM_BACKOFF_BASE_MS = 2_000;
const RETRYABLE_STATUSES = new Set([500, 503]);

/** End-to-end latency target for one run; every LLM call and the research step are sized to fit inside it. */
const RUN_BUDGET_MS = 45_000;
const SUPERVISOR_TIMEOUT_MS = 12_000;
const SYNTHESIZER_TIMEOUT_MS = 18_000;
const JUDGE_TIMEOUT_MS = 10_000;
/** Minimum time left before another synthesizer → critic revision cycle is attempted. */
const REVISION_MIN_REMAINING_MS = 15_000;

// Reference list prices (USD per 1M tokens) for a Flash-class model. Free Tier usage is billed $0;
// the telemetry reports what the same run would cost on the paid tier.
const PRICE_INPUT_PER_M = 0.3;
const PRICE_OUTPUT_PER_M = 2.5;

// Google AI Studio Free Tier budget.
const FREE_TIER_RPM = 15;
const FREE_TIER_RPD = 1500;

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

const genai = GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: GEMINI_API_KEY, httpOptions: { headers: { 'User-Agent': 'aistudio-build' } } })
  : undefined;

const ai = genkit({ plugins: GEMINI_API_KEY ? [googleAI({ apiKey: GEMINI_API_KEY })] : [] });

// ---------------------------------------------------------------------------
// Free Tier rate-limit guard (sliding window RPM + daily cap)
// ---------------------------------------------------------------------------

const requestLog: number[] = [];
let dailyCount = 0;
let dailyKey = new Date().toISOString().slice(0, 10);

function usedLastMinute(now = Date.now()): number {
  while (requestLog.length > 0 && now - requestLog[0] >= 60_000) requestLog.shift();
  return requestLog.length;
}

function tryAcquireLlmSlot(): boolean {
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  if (today !== dailyKey) {
    dailyKey = today;
    dailyCount = 0;
  }
  if (usedLastMinute(now) >= FREE_TIER_RPM || dailyCount >= FREE_TIER_RPD) return false;
  requestLog.push(now);
  dailyCount += 1;
  return true;
}

// ---------------------------------------------------------------------------
// Gemini helper
// ---------------------------------------------------------------------------

interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

interface LlmResult extends LlmUsage {
  text: string;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Calls Gemini within `deadline` (epoch ms). Each attempt is capped at `timeoutMs`; retries only fit if time remains. */
async function callGemini(prompt: string, options: { json?: boolean; timeoutMs: number; deadline: number }): Promise<LlmResult> {
  if (!genai) throw new LlmUnavailableError('not_configured', failureLabel('not_configured'));
  const client = genai;
  const attempt = () => {
    const budget = Math.min(options.timeoutMs, options.deadline - Date.now());
    if (budget < 3_000) throw new LlmUnavailableError('budget', failureLabel('budget'));
    // Every attempt, including retries, counts against the Free Tier budget.
    if (!tryAcquireLlmSlot()) throw new LlmUnavailableError('rate_guard', failureLabel('rate_guard'));
    return withTimeout(
      client.models.generateContent({
        model: GEMINI_MODEL,
        contents: prompt,
        config: {
          temperature: options.json ? 0.2 : 0.4,
          ...(options.json ? { responseMimeType: 'application/json' } : {}),
        },
      }),
      budget,
      'Gemini call',
    );
  };

  let response;
  for (let retry = 0; ; retry += 1) {
    try {
      response = await attempt();
      break;
    } catch (error) {
      const backoff = LLM_BACKOFF_BASE_MS * 2 ** retry;
      const retryable = error instanceof ApiError && RETRYABLE_STATUSES.has(error.status);
      if (!retryable || retry >= LLM_MAX_RETRIES || options.deadline - Date.now() < backoff + 3_000) throw error;
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }
  const text = response.text ?? '';
  if (!text.trim()) throw new Error('Gemini returned an empty response');
  return {
    text,
    inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
  };
}

/** Parses model JSON (tolerating markdown fences) and validates it; throws on any mismatch. */
function parseJson<T>(text: string, schema: z.ZodType<T>): T {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  const result = schema.safeParse(JSON.parse(cleaned));
  if (!result.success) {
    throw new Error(`Schema validation failed: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return result.data;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

// ---------------------------------------------------------------------------
// Google Agent Skills (Genkit tools)
// ---------------------------------------------------------------------------

const webResearch = ai.defineTool(
  {
    name: 'web_research',
    description:
      'Resolves a company\'s official website and fetches a bounded set of its public pages (home, pricing, product, docs) with SSRF protection, timeouts and size limits, extracting verbatim evidence.',
    inputSchema: z.object({ company: z.string().optional(), url: z.string().optional(), domainGuess: z.string().nullable().optional(), budgetMs: z.number() }),
    outputSchema: z.any(),
  },
  async ({ company, url, domainGuess, budgetMs }) => researchCompany({ company, url }, { domainGuess, budgetMs }),
);

const sandboxPythonExecutor = ai.defineTool(
  {
    name: 'sandbox_python_executor',
    description:
      'Validates structured data extracted from retrieved pages and computes pricing and friction metrics in an isolated V8 context, so no arithmetic is delegated to the LLM.',
    inputSchema: z.object({ research: z.any() }),
    outputSchema: z.any(),
  },
  async ({ research }) => executeSandbox(research as ResearchResult),
);

const evalCriticJudge = ai.defineTool(
  {
    name: 'eval_critic_judge',
    description: 'LLM-as-a-Judge that checks goal alignment, contradictions and fact/hypothesis confusion in the drafted report.',
    inputSchema: z.object({ prompt: z.string(), deadline: z.number() }),
    outputSchema: z.object({ judge: CriticJudgeSchema, usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }) }),
  },
  async ({ prompt, deadline }) => {
    const result = await callGemini(prompt, { json: true, timeoutMs: JUDGE_TIMEOUT_MS, deadline });
    return { judge: parseJson(result.text, CriticJudgeSchema), usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens } };
  },
);

const SKILL_NAMES = ['web_research', 'sandbox_python_executor', 'eval_critic_judge'];

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

type Emit = (event: AgentStreamEvent) => void;

interface NodeOutcome<T> {
  value: T;
  usage: LlmUsage;
}

interface RunContext {
  startedAt: number;
  deadline: number;
  traces: NodeTrace[];
  warnings: string[];
  llmCalls: number;
  emit: Emit;
}

function costOf(usage: LlmUsage): number {
  return (usage.inputTokens * PRICE_INPUT_PER_M + usage.outputTokens * PRICE_OUTPUT_PER_M) / 1_000_000;
}

interface NodeSpec<T> {
  node: NodeId;
  cycle: number;
  live: (() => Promise<NodeOutcome<T>>) | null;
  fallback: (reason: string) => T;
  summarize: (value: T) => string;
  usesLlm?: boolean;
  /** Lets a node that ran report a degraded outcome (e.g. research that retrieved nothing) as fallback. */
  classify?: (value: T) => { mode: ExecutionMode; reason?: string; kind?: LlmFailureKind };
  unavailableReason?: string;
  unavailableKind?: LlmFailureKind;
}

/** Runs one DAG node: tries the live path, records telemetry, and degrades to the deterministic fallback on any failure. */
async function runNode<T>(ctx: RunContext, spec: NodeSpec<T>): Promise<{ value: T; mode: ExecutionMode }> {
  const started = performance.now();
  let value: T;
  let usage: LlmUsage = { inputTokens: 0, outputTokens: 0 };
  let mode: ExecutionMode = 'live';
  let fallbackReason: string | undefined;
  let fallbackKind: LlmFailureKind | undefined;

  if (spec.live) {
    try {
      const outcome = await spec.live();
      value = outcome.value;
      usage = outcome.usage;
      const classified = spec.classify?.(value);
      if (classified?.mode === 'fallback') {
        mode = 'fallback';
        fallbackReason = classified.reason;
        fallbackKind = classified.kind;
      }
      // Count only nodes whose LLM call actually succeeded (e.g. not a critic whose judge failed).
      if (spec.usesLlm !== false && mode === 'live') ctx.llmCalls += 1;
    } catch (error) {
      if (spec.usesLlm !== false) {
        const classified = classifyLlmError(error);
        fallbackReason = classified.message;
        fallbackKind = classified.kind;
      } else fallbackReason = errorMessage(error);
      mode = 'fallback';
      value = spec.fallback(fallbackReason);
    }
  } else {
    fallbackReason = spec.unavailableReason ?? 'Live dependency unavailable';
    fallbackKind = spec.usesLlm !== false ? (spec.unavailableKind ?? 'skipped') : undefined;
    mode = 'fallback';
    value = spec.fallback(fallbackReason);
  }

  const trace: NodeTrace = {
    id: `${spec.node}-${spec.cycle}`,
    node: spec.node,
    cycle: spec.cycle,
    mode,
    startOffsetMs: round(started - ctx.startedAt),
    latencyMs: round(performance.now() - started),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd: round(costOf(usage), 6),
    summary: spec.summarize(value),
    detail: value,
    ...(fallbackReason ? { fallbackReason } : {}),
    ...(fallbackKind ? { fallbackKind } : {}),
  };
  ctx.traces.push(trace);
  ctx.emit({ type: 'trace', trace });
  return { value, mode };
}

function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)];
}

function displayName(input: AgentRunRequest): string {
  if (input.company) return input.company;
  try {
    return new URL(/^[a-z]+:\/\//i.test(input.url ?? '') ? (input.url ?? '') : `https://${input.url}`).hostname.replace(/^www\./, '');
  } catch {
    return input.url ?? 'the company';
  }
}

function emptyResearch(input: AgentRunRequest, reason: string): ResearchOutput {
  return {
    target: { company: displayName(input), url: null, resolvedBy: 'unresolved', candidatesTried: [] },
    status: 'fallback',
    statusReason: reason,
    sources: [],
    evidence: [],
    prices: [],
    percentFees: [],
    discardedPriceFragments: 0,
    durationMs: 0,
    corpora: {},
  };
}

// --- Prompts ---------------------------------------------------------------

function supervisorPrompt(input: AgentRunRequest, company: string): string {
  return [
    'You are the Supervisor of a deductive research agent. Like Sherlock Holmes, you form hypotheses first and only accept them once evidence is found.',
    `Company: ${company}`,
    `Company URL provided by the user: ${input.url || 'none'}`,
    `User goal: ${input.goal}`,
    `Domain: ${input.domain}`,
    'Produce exactly three testable hypotheses, in this order of area: "product", "pricing", "friction".',
    '- product: value proposition, features, differentiation and customer fit.',
    '- pricing: plan structure, transparency, positioning and price vs. perceived value.',
    '- friction: onboarding obstacles, complexity, limitations, drop-off points and conversion barriers.',
    'Adapt each hypothesis to the goal and domain. They are claims to test, never facts.',
    'evidenceNeeded lists the public observations that would test the hypothesis; refutedBy names one observation that would refute it.',
    'If the goal is about churn, frame hypotheses around public signals only: you do not have customer, usage, renewal or cancellation data.',
    'officialDomainGuess: the company\'s official website domain (e.g. "example.com") only if you are confident; otherwise null.',
    'Reply with JSON only, exactly this shape:',
    '{"hypotheses":[{"area":"product"|"pricing"|"friction","statement":<string>,"evidenceNeeded":[<string>],"refutedBy":<string>}],"officialDomainGuess":<string|null>,"researchFocus":<string>}',
  ].join('\n\n');
}

function synthesizerPrompt(args: {
  input: AgentRunRequest;
  research: ResearchResult;
  hypotheses: HypothesisAssessment[];
  sandbox: SandboxResult;
  churn: ReturnType<typeof churnAssessment>;
  feedback: string[];
}): string {
  const { input, research, hypotheses, sandbox, churn, feedback } = args;
  // Keep the prompt bounded: all non-price evidence first, then at most 40 price items.
  const evidence = [...research.evidence.filter((e) => e.kind !== 'pricing'), ...research.evidence.filter((e) => e.kind === 'pricing').slice(0, 40)]
    .slice(0, 90)
    .map(
      (e) =>
        `${e.id} [${e.kind}${e.signal ? `:${e.signal}` : ''}${e.contextual === false ? ' GENERIC-CTA' : ''}] (${e.sourceId}${e.context ? `, under "${e.context}"` : ''}) "${e.snippet.slice(0, 240)}"`,
    )
    .join('\n');
  const metrics = sandbox.metrics
    .map((m) => `${m.id} ${m.label}: ${m.status === 'ok' ? `${m.value} ${m.unit} (${m.kind})` : `INSUFFICIENT DATA — ${m.note}`}`)
    .join('\n');
  const hyp = hypotheses
    .map(
      (h) =>
        `${h.id} [${h.area}] ${h.statement}\n   evidence coverage: ${h.coverage} (max verdict confidence: ${h.maxVerdictConfidence ?? 'none — must be inconclusive'}); found: ${h.categoriesFound.join(', ') || 'none'}; missing: ${h.categoriesMissing.join(', ') || 'none'}; evidence: ${h.evidenceFound.join(', ') || 'none'}`,
    )
    .join('\n');
  const failed = research.sources.filter((s) => s.status !== 'ok').map((s) => `${s.url} (${s.error ?? s.status})`);
  return [
    'You are the Executive Synthesizer of a deductive research agent. Write an intelligence report about the company below.',
    `Company: ${research.target.company} (${research.target.url ?? 'no URL'})`,
    `User goal: ${input.goal}`,
    `Domain: ${input.domain}`,
    `Research status: ${research.status} — ${research.statusReason}`,
    failed.length ? `Sources that FAILED (never cite or describe their content): ${failed.join('; ')}` : 'All attempted sources were retrieved.',
    `Evidence retrieved from public pages (the ONLY facts you may state):\n${evidence || '(none)'}`,
    `Sandbox metrics (authoritative; quote values exactly, never compute new numbers):\n${metrics}`,
    `Hypotheses:\n${hyp}`,
    churn.status === 'provisional' ? `Churn: ${churn.note} Never state churn rates, never claim causes of churn; describe risks as provisional signals.` : '',
    feedback.length ? `The Critic rejected the previous draft. Fix every issue:\n- ${feedback.join('\n- ')}` : '',
    'Rules:',
    '- confirmedFindings: only facts directly stated in the evidence, each citing evidence ids (e.g. "E3"). No hedging and no evaluations (friction, barrier, confusing, complex) — those are inferences.',
    '- inferences: reasoned conclusions that go beyond the evidence, phrased as hypotheses; state the reasoning, what it cannot show, and cite the evidence it rests on.',
    '- A "Contact sales" or "Request a demo" phrase marked GENERIC-CTA is a header/button and is NOT evidence of friction. Only phrases tied to a plan, price or product may support a friction inference, and even then present it as a hypothesis.',
    '- risks and opportunities are potential effects, not facts: say they are unverified.',
    '- openQuestions: what the evidence cannot answer.',
    '- hypothesisVerdicts: one per hypothesis (H1..H3): "supported", "refuted" or "inconclusive", with rationale and evidence ids. Evidence coverage is not confidence: coverage only caps it. confidence must be null for "inconclusive" and must not exceed the stated max verdict confidence. Use "inconclusive" when the evidence does not decide the question.',
    '- Use only numbers that appear in the evidence or the sandbox metrics. Do not invent internal metrics (revenue, churn, conversion, usage).',
    '- Correlation is not causation: do not claim that one observation causes an outcome.',
    '- recommendations: actionable for the goal; each with expectedImpact (qualitative), effort, timeframe, a KPI to track, and the hypothesisId it tests.',
    'Reply with JSON only, exactly this shape:',
    '{"executiveSummary":<string>,"companyProfile":<string>,"confirmedFindings":[{"statement":<string>,"evidenceIds":[<id>]}],"inferences":[{"statement":<string>,"reasoning":<string>,"evidenceIds":[<id>]}],"openQuestions":[<string>],"hypothesisVerdicts":[{"id":"H1","verdict":"supported"|"refuted"|"inconclusive","confidence":"low"|"medium"|"high"|null,"rationale":<string>,"evidenceIds":[<id>]}],"risks":[{"title":<string>,"detail":<string>,"priority":"P0"|"P1"|"P2","evidenceIds":[<id>]}],"opportunities":[{"title":<string>,"detail":<string>,"priority":"P0"|"P1"|"P2","evidenceIds":[<id>]}],"recommendations":[{"action":<string>,"expectedImpact":<string>,"effort":"low"|"medium"|"high","timeframe":<string>,"kpi":<string>,"hypothesisId":"H1"|"H2"|"H3"}]}',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function judgePrompt(input: AgentRunRequest, draft: ReportDraft): string {
  const s = draft.synthesis;
  return [
    'You are the Critic (LLM-as-a-Judge) of a research agent. Review the drafted report strictly.',
    `User goal: ${input.goal}`,
    `Executive summary: ${s.executiveSummary}`,
    `Confirmed findings:\n${s.confirmedFindings.map((f) => `- ${f.statement}`).join('\n') || '(none)'}`,
    `Inferences:\n${s.inferences.map((f) => `- ${f.statement}`).join('\n') || '(none)'}`,
    `Hypothesis verdicts:\n${s.hypothesisVerdicts.map((v) => `- ${v.id}: ${v.verdict} — ${v.rationale}`).join('\n') || '(none)'}`,
    `Recommendations:\n${s.recommendations.map((r) => `- ${r.action} (KPI: ${r.kpi})`).join('\n')}`,
    'Check: (1) do the recommendations answer the user goal? (2) are there contradictions between statements? (3) is any hypothesis or inference presented as a confirmed fact?',
    'Reply with JSON only: {"goalAlignment":"pass"|"fail","goalAlignmentNote":<string>,"contradictions":[<string>],"factHypothesisConfusion":[<string>]}',
    'Return empty arrays when there are no problems.',
  ].join('\n\n');
}

// --- Report assembly ------------------------------------------------------------

function assembleReport(args: {
  draft: ReportDraft;
  research: ResearchResult;
  sandbox: SandboxResult & { input: SandboxInput };
  limitations: string[];
}): IntelligenceReport {
  const { draft, research, sandbox, limitations } = args;
  const s = draft.synthesis;
  const hypotheses = applyVerdicts(draft.hypotheses, s.hypothesisVerdicts);
  const evidenceSource = new Map(research.evidence.map((e) => [e.id, e.sourceId]));
  const supports = new Map<string, Set<string>>();
  const cite = (ids: string[], label: string) => {
    for (const id of ids) {
      const sourceId = evidenceSource.get(id);
      if (!sourceId) continue;
      if (!supports.has(sourceId)) supports.set(sourceId, new Set());
      supports.get(sourceId)?.add(label);
    }
  };
  s.confirmedFindings.forEach((f, i) => cite(f.evidenceIds, `Finding ${i + 1}`));
  s.inferences.forEach((f, i) => cite(f.evidenceIds, `Inference ${i + 1}`));
  hypotheses.forEach((h) => cite([...h.verdictEvidence, ...h.evidenceFound], `${h.id} (${h.area})`));
  s.risks.forEach((r) => cite(r.evidenceIds, `Risk: ${r.title}`));
  s.opportunities.forEach((o) => cite(o.evidenceIds, `Opportunity: ${o.title}`));
  sandbox.metrics.forEach((m) => cite(m.inputs, `${m.id} ${m.label}`));

  return {
    ...s,
    company: research.target,
    researchStatus: research.status,
    hypotheses,
    // Exactly the validated, de-duplicated prices the sandbox computed on, so the table and M1 always agree.
    pricing: sandbox.input.prices,
    percentFees: sandbox.input.percentFees,
    metrics: sandbox.metrics,
    evidence: research.evidence,
    sources: research.sources.map((src) => ({ ...src, supports: [...(supports.get(src.id) ?? [])] })),
    churn: draft.churn,
    limitations,
    codeArtifact: sandbox.code,
  };
}

async function runAgent(input: AgentRunRequest, emit: Emit): Promise<AgentRunResponse> {
  const startedAt = performance.now();
  const ctx: RunContext = { startedAt, deadline: Date.now() + RUN_BUDGET_MS, traces: [], warnings: [], llmCalls: 0, emit };
  const remaining = () => ctx.deadline - Date.now();
  const maxCycles = Math.min(input.depth, MAX_CYCLES);
  const company = displayName(input);
  const churn = churnAssessment(input.goal);
  if (!genai) ctx.warnings.push('GEMINI_API_KEY not set — LLM nodes use the deterministic engine; web research still runs live.');

  const plan: PlanStep[] = [
    { id: 'planner-1', node: 'planner', title: `Form three deductive hypotheses about ${company}`, dependsOn: [] },
    { id: 'retrieval-1', node: 'retrieval', title: input.url ? `Fetch and extract public pages from ${input.url}` : `Identify ${company}'s official site, then fetch its public pages`, dependsOn: ['planner-1'] },
    { id: 'sandbox-1', node: 'sandbox', title: 'Validate extracted data and compute pricing & friction metrics', dependsOn: ['retrieval-1'] },
    { id: 'synthesizer-1', node: 'synthesizer', title: 'Draft the intelligence report from evidence and metrics', dependsOn: ['sandbox-1'] },
    { id: 'critic-1', node: 'critic', title: 'Validate claims, citations, calculations and goal fit', dependsOn: ['synthesizer-1'] },
  ];
  emit({ type: 'plan', plan });

  // 1. Supervisor — deductive hypotheses (before any evidence is seen)
  const supervisor = await runNode<SupervisorOutput>(ctx, {
    node: 'planner',
    cycle: 1,
    live: genai
      ? async () => {
          const result = await callGemini(supervisorPrompt(input, company), { json: true, timeoutMs: SUPERVISOR_TIMEOUT_MS, deadline: ctx.deadline - 25_000 });
          const parsed = parseJson(result.text, SupervisorOutputSchema);
          const ordered = (['product', 'pricing', 'friction'] as const).map((area) => parsed.hypotheses.find((h) => h.area === area));
          if (ordered.some((h) => !h)) throw new Error('Supervisor did not return one hypothesis per area');
          return { value: { ...parsed, hypotheses: ordered as SupervisorOutput['hypotheses'] }, usage: result };
        }
      : null,
    fallback: () => ({ hypotheses: defaultHypotheses(company, input.goal, input.domain), officialDomainGuess: null, researchFocus: `Public positioning, pricing and adoption path of ${company}` }),
    summarize: (v) => `3 hypotheses · focus: ${v.researchFocus}`,
    unavailableReason: `${failureLabel('not_configured')}; using deterministic hypothesis templates`,
    unavailableKind: 'not_configured',
  });

  // 2. Retrieval — live web research
  const research = (
    await runNode<ResearchOutput>(ctx, {
      node: 'retrieval',
      cycle: 1,
      live: async () => ({
        value: (await webResearch({
          company: input.company,
          url: input.url,
          domainGuess: supervisor.value.officialDomainGuess,
          budgetMs: Math.max(3_000, Math.min(RESEARCH_DEFAULTS.budgetMs, remaining() - 12_000)),
        })) as ResearchOutput,
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
      fallback: (reason) => emptyResearch(input, `Research tool failed: ${reason}`),
      summarize: (r) => `${r.status.toUpperCase()} · ${r.sources.filter((s) => s.status === 'ok').length}/${r.sources.length} sources · ${r.evidence.length} evidence items`,
      usesLlm: false,
      classify: (r) => (r.status === 'fallback' ? { mode: 'fallback', reason: r.statusReason } : { mode: 'live' }),
    })
  ).value;
  if (research.status !== 'live') ctx.warnings.push(research.statusReason);

  // 3. Sandbox — deterministic metrics over validated extracted data
  const sandbox = (
    await runNode<SandboxResult & { input: SandboxInput }>(ctx, {
      node: 'sandbox',
      cycle: 1,
      live: async () => ({ value: (await sandboxPythonExecutor({ research })) as SandboxResult & { input: SandboxInput }, usage: { inputTokens: 0, outputTokens: 0 } }),
      fallback: (reason) => ({ language: 'javascript', code: '', stdout: '', metrics: [], rejectedInputs: [`Sandbox failed: ${reason}`], durationMs: 0, input: { pagesRetrieved: false, pricingPageRetrieved: false, prices: [], percentFees: [], customPricingEvidence: [], featureEvidence: [], friction: [] } }),
      summarize: (s) => `${s.metrics.filter((m) => m.status === 'ok').length}/${s.metrics.length} metrics computed · ${s.rejectedInputs.length} inputs rejected`,
      usesLlm: false,
    })
  ).value;

  const hypotheses = assessHypotheses(supervisor.value.hypotheses, research, sandbox.metrics);
  const criticCtx: CriticContext = {
    goal: input.goal,
    churnGoal: isChurnGoal(input.goal),
    company: research.target.company || company,
    url: research.target.url,
    research,
    corpora: research.corpora,
    metrics: sandbox.metrics,
    reference: referenceMetrics(sandbox.input),
  };
  const baseline = deterministicSynthesis({ company: criticCtx.company, url: research.target.url, goal: input.goal, research, hypotheses, metrics: sandbox.metrics });

  // 4–5. Synthesizer ⇄ Critic, up to maxCycles
  const synthesize = (cycle: number, feedback: string[]) =>
    runNode<Synthesis>(ctx, {
      node: 'synthesizer',
      cycle,
      live:
        genai && research.status !== 'fallback'
          ? async () => {
              const prompt = synthesizerPrompt({ input, research, hypotheses, sandbox, churn, feedback });
              const result = await callGemini(prompt, { json: true, timeoutMs: SYNTHESIZER_TIMEOUT_MS, deadline: ctx.deadline - 4_000 });
              return { value: parseJson(result.text, SynthesisSchema), usage: result };
            }
          : null,
      fallback: () => baseline,
      summarize: (s) => `${s.confirmedFindings.length} findings · ${s.inferences.length} inferences · ${s.recommendations.length} recommendations`,
      unavailableReason: genai ? 'No sources were retrieved; reporting limitations without LLM synthesis' : `${failureLabel('not_configured')}; evidence-only deterministic report`,
      unavailableKind: genai ? 'skipped' : 'not_configured',
    });

  const evaluate = (cycle: number, draft: ReportDraft) =>
    runNode<CriticReport>(ctx, {
      node: 'critic',
      cycle,
      live: async () => {
        const deterministic = runDeterministicChecks(draft, criticCtx);
        let judge: CriticJudge | null = null;
        let usage: LlmUsage = { inputTokens: 0, outputTokens: 0 };
        let unavailable: { kind: LlmFailureKind; message: string } | null = null;
        if (!genai) unavailable = { kind: 'not_configured', message: failureLabel('not_configured') };
        else if (research.status === 'fallback') unavailable = { kind: 'skipped', message: 'No sources were retrieved, so there was nothing for the LLM judge to assess' };
        else {
          try {
            const out = await evalCriticJudge({ prompt: judgePrompt(input, draft), deadline: ctx.deadline });
            judge = out.judge;
            usage = out.usage;
          } catch (error) {
            unavailable = classifyLlmError(error);
          }
        }
        const report = summarizeCritic(applyJudge(deterministic, judge), research.status, judge ? 'live' : 'unavailable');
        if (unavailable) {
          report.llmJudgeUnavailableReason = unavailable.message;
          report.llmJudgeFailureKind = unavailable.kind;
          report.issues.push({ severity: 'warning', target: 'synthesizer', message: `LLM judge did not run: ${unavailable.message}` });
        }
        return { value: report, usage };
      },
      fallback: (reason) => ({ status: 'fail', checks: [], issues: [{ severity: 'error', target: 'synthesizer', message: `Critic failed: ${reason}` }], llmJudge: 'unavailable', llmJudgeUnavailableReason: reason }),
      summarize: (r) => `${r.status.toUpperCase()} · ${r.checks.filter((c) => c.status === 'pass').length}/${r.checks.length} checks passed · ${r.llmJudge === 'live' ? 'rules + LLM judge' : 'rule checks only'}`,
      classify: (r) =>
        r.llmJudge === 'live'
          ? { mode: 'live' }
          : { mode: 'fallback', reason: `Rule checks only — LLM judge did not run: ${r.llmJudgeUnavailableReason ?? 'unavailable'}`, kind: r.llmJudgeFailureKind ?? 'error' },
    });

  let cycle = 1;
  let synthesis = await synthesize(cycle, []);
  let draft: ReportDraft = { synthesis: synthesis.value, hypotheses: applyVerdicts(hypotheses, synthesis.value.hypothesisVerdicts), churn };
  let critic = (await evaluate(cycle, draft)).value;

  while (critic.status === 'fail' && cycle < maxCycles && synthesis.mode === 'live' && remaining() > REVISION_MIN_REMAINING_MS) {
    cycle += 1;
    plan.push(
      { id: `synthesizer-${cycle}`, node: 'synthesizer', title: `Revision ${cycle}: address ${critic.issues.filter((i) => i.severity === 'error').length} critic issues`, dependsOn: [`critic-${cycle - 1}`] },
      { id: `critic-${cycle}`, node: 'critic', title: `Re-validate revision ${cycle}`, dependsOn: [`synthesizer-${cycle}`] },
    );
    emit({ type: 'plan', plan });
    const feedback = critic.issues.filter((i) => i.target === 'synthesizer').map((i) => i.message);
    synthesis = await synthesize(cycle, feedback);
    draft = { synthesis: synthesis.value, hypotheses: applyVerdicts(hypotheses, synthesis.value.hypothesisVerdicts), churn };
    critic = (await evaluate(cycle, draft)).value;
  }

  const limitations: string[] = [];
  if (critic.status === 'fail') {
    // Revision budget exhausted: strip or replace whatever failed, then re-validate deterministically.
    const repaired = repairDraft(draft, criticCtx, baseline);
    draft = repaired.draft;
    const judgeCheck = critic.checks.find((c) => c.id === 'C9');
    const recheck = runDeterministicChecks(draft, criticCtx);
    if (judgeCheck) recheck.checks.push(judgeCheck.status === 'fail' ? { ...judgeCheck, status: 'warn', detail: `Unresolved after ${cycle} cycle(s): ${judgeCheck.detail}` } : judgeCheck);
    critic = summarizeCritic(recheck, research.status, critic.llmJudge);
    if (critic.status === 'fail') critic.status = 'pass_with_limitations';
    limitations.push(...repaired.notes, `The Critic still found problems after ${cycle} of ${maxCycles} revision cycle(s); failing content was removed or replaced with evidence-only text.`);
  }

  if (research.status !== 'live') limitations.push(research.statusReason);
  for (const src of research.sources.filter((s) => s.status !== 'ok')) limitations.push(`Source not used — ${src.url}: ${src.error ?? src.status}`);
  limitations.push('No internal company data (customers, usage, revenue, renewals, cancellations) was available; conclusions rely on public pages only.');
  if (churn.status === 'provisional') limitations.push(churn.note);
  for (const m of sandbox.metrics.filter((x) => x.status === 'insufficient_data')) limitations.push(`${m.id} ${m.label}: insufficient data — ${m.note}.`);
  limitations.push(...sandbox.rejectedInputs);
  if (research.discardedPriceFragments > 0) {
    limitations.push(`${research.discardedPriceFragments} price amounts on pricing pages were discarded because no product, line item, unit or period could be linked to them.`);
  }
  if (synthesis.mode === 'fallback') limitations.push('The narrative was assembled deterministically from retrieved text; no LLM synthesis was used.');
  if (critic.llmJudge === 'unavailable') limitations.push(`Validation used deterministic rule checks only; the LLM judge did not run (${critic.llmJudgeUnavailableReason ?? 'unavailable'}).`);

  const llmTraces = ctx.traces.filter((t) => t.node === 'planner' || t.node === 'synthesizer' || t.node === 'critic');
  const modes = new Set(llmTraces.map((t) => t.mode));
  const failures = llmTraces
    .filter((t) => t.mode === 'fallback')
    .map((t) => ({ node: t.node, cycle: t.cycle, kind: t.fallbackKind ?? 'error', message: t.fallbackReason ?? 'unavailable' }));
  const gemini: GeminiStatus = {
    status: !genai ? 'not_configured' : failures.length === 0 ? 'live' : failures.length === llmTraces.length ? 'unavailable' : 'partial',
    quotaExhausted: failures.some((f) => f.kind === 'quota'),
    failures,
  };
  if (gemini.quotaExhausted) {
    const nodes = [...new Set(failures.filter((f) => f.kind === 'quota').map((f) => f.node))].join(', ');
    const notice = `Gemini quota exhausted (HTTP 429): ${nodes} ran on the deterministic engine. Nothing in those parts was written or judged by Gemini.`;
    ctx.warnings.unshift(notice);
    limitations.unshift(notice);
  }

  const report = assembleReport({ draft, research, sandbox, limitations });
  const telemetry: Telemetry = {
    model: genai ? GEMINI_MODEL : 'deterministic-fallback',
    llmMode: modes.size > 1 ? 'hybrid' : modes.has('live') ? 'live' : 'fallback',
    researchStatus: research.status,
    totalLatencyMs: round(performance.now() - startedAt),
    p95LatencyMs: round(p95(ctx.traces.map((t) => t.latencyMs))),
    inputTokens: ctx.traces.reduce((sum, t) => sum + t.inputTokens, 0),
    outputTokens: ctx.traces.reduce((sum, t) => sum + t.outputTokens, 0),
    costUsd: round(ctx.traces.reduce((sum, t) => sum + t.costUsd, 0), 6),
    cycles: cycle,
    maxCycles,
    llmCalls: ctx.llmCalls,
    sourcesOk: research.sources.filter((s) => s.status === 'ok').length,
    sourcesFailed: research.sources.filter((s) => s.status !== 'ok').length,
    gemini,
  };

  const response: AgentRunResponse = {
    runId: randomUUID(),
    goal: input.goal,
    domain: input.domain,
    plan,
    traces: ctx.traces.map((t) => (t.node === 'retrieval' ? { ...t, detail: { ...(t.detail as ResearchOutput), corpora: undefined } } : t)),
    report,
    critic,
    telemetry,
    warnings: ctx.warnings,
  };
  emit({ type: 'result', result: response });
  return response;
}

const nexusAgentFlow = ai.defineFlow(
  { name: 'nexusAgentRun', inputSchema: AgentRunRequestSchema },
  async (input, { sendChunk }) => runAgent(input, sendChunk),
);

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const startedAt = Date.now();
const app = express();
app.use(express.json({ limit: '64kb' }));

app.get('/api/health', (_req, res) => {
  const body: HealthResponse = {
    status: 'ok',
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    gemini: { configured: Boolean(GEMINI_API_KEY), model: GEMINI_MODEL },
    genkit: {
      initialized: true,
      cliInstalled: existsSync(path.join(ROOT, 'node_modules', 'genkit-cli', 'package.json')),
      tools: SKILL_NAMES,
      flows: ['nexusAgentRun'],
    },
    rateLimit: { rpm: FREE_TIER_RPM, usedLastMinute: usedLastMinute() },
    research: {
      maxPages: RESEARCH_DEFAULTS.maxPages,
      budgetMs: RESEARCH_DEFAULTS.budgetMs,
      perRequestTimeoutMs: RESEARCH_DEFAULTS.perRequestTimeoutMs,
      maxBytes: RESEARCH_DEFAULTS.maxBytes,
    },
  };
  res.json(body);
});

app.post('/api/agent/run', async (req, res) => {
  const parsed = AgentRunRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', issues: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) });
    return;
  }

  const streaming = req.headers.accept?.includes('application/x-ndjson') ?? false;
  if (!streaming) {
    try {
      res.json(await nexusAgentFlow(parsed.data));
    } catch (error) {
      res.status(500).json({ error: errorMessage(error) });
    }
    return;
  }

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();
  const write = (event: AgentStreamEvent) => {
    if (res.writableEnded) return;
    // Page corpora are server-side verification data only; never stream them to the browser.
    if (event.type === 'trace' && event.trace.node === 'retrieval') {
      event = { type: 'trace', trace: { ...event.trace, detail: { ...(event.trace.detail as ResearchOutput), corpora: undefined } } };
    }
    res.write(`${JSON.stringify(event)}\n`);
  };
  try {
    await nexusAgentFlow(parsed.data, { onChunk: (chunk: unknown) => write(chunk as AgentStreamEvent) });
  } catch (error) {
    write({ type: 'error', message: errorMessage(error) });
  }
  res.end();
});

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

if (IS_PRODUCTION) {
  const dist = path.join(ROOT, 'dist');
  app.use(express.static(dist));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(dist, 'index.html'));
  });
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({ root: ROOT, server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
}

app.listen(PORT, () => {
  console.log(`NexusAgent running on http://localhost:${PORT} (${IS_PRODUCTION ? 'production' : 'development'})`);
  console.log(`Gemini: ${GEMINI_API_KEY ? `configured (${GEMINI_MODEL})` : 'not configured — deterministic fallback engine active'}`);
});
