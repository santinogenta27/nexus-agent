import { useMemo, useState } from 'react';
import { motion } from 'motion/react';
import {
  AlertTriangle,
  BrainCircuit,
  Building2,
  Calculator,
  Coins,
  Gauge,
  Globe,
  Link2,
  Loader2,
  Play,
  Repeat,
  Scale,
  ShieldCheck,
  Sparkles,
  Timer,
  Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { DOMAINS, MAX_CYCLES } from '../types/agent';
import type { AgentRunResponse, AgentStreamEvent, CriticReport, Domain, NodeId, NodeTrace, PlanStep, ResearchStatus, ResolutionMethod } from '../types/agent';
import { EXAMPLES } from '../data/presets';
import ResearchReport, { CriticBadge, ResearchBadge } from './ResearchReport';

interface NodeMeta {
  id: NodeId;
  label: string;
  role: string;
  icon: LucideIcon;
  x: number;
  deps: NodeId[];
}

const NODE_Y = 150;
const NODES: NodeMeta[] = [
  { id: 'planner', label: 'Supervisor', role: '3 hypotheses', icon: BrainCircuit, x: 90, deps: [] },
  { id: 'retrieval', label: 'Retrieval', role: 'Live web research', icon: Globe, x: 260, deps: ['planner'] },
  { id: 'sandbox', label: 'Sandbox', role: 'Verifiable metrics', icon: Calculator, x: 430, deps: ['retrieval'] },
  { id: 'synthesizer', label: 'Synthesizer', role: 'Intelligence report', icon: Sparkles, x: 600, deps: ['sandbox'] },
  { id: 'critic', label: 'Critic', role: 'Mandatory validation', icon: Scale, x: 770, deps: ['synthesizer'] },
];

const NODE_W = 140;
const NODE_H = 64;

type NodeStatus = 'idle' | 'running' | 'live' | 'partial' | 'fallback';

const STATUS_STYLE: Record<NodeStatus, { stroke: string; fill: string; text: string; label: string }> = {
  idle: { stroke: '#334155', fill: '#0f172a', text: 'text-slate-500', label: 'Idle' },
  running: { stroke: '#f59e0b', fill: '#1c1917', text: 'text-amber-300', label: 'Running' },
  live: { stroke: '#34d399', fill: '#022c22', text: 'text-emerald-300', label: 'Live' },
  partial: { stroke: '#fb923c', fill: '#1f1308', text: 'text-orange-300', label: 'Partial' },
  fallback: { stroke: '#38bdf8', fill: '#082f49', text: 'text-sky-300', label: 'Fallback' },
};

const RESOLUTION_LABEL: Record<ResolutionMethod, string> = {
  user_url: 'URL provided by you',
  llm_suggestion_verified: 'Suggested by the Supervisor, verified on the page',
  domain_heuristic_verified: 'Found by domain lookup, verified on the page',
  unresolved: 'Official site not identified',
};

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}

function formatUsd(usd: number): string {
  return `$${usd.toFixed(usd > 0 && usd < 0.01 ? 5 : 4)}`;
}

function isCriticReport(detail: unknown): detail is CriticReport {
  return typeof detail === 'object' && detail !== null && 'checks' in detail && 'status' in detail;
}

interface RetrievalDetail {
  status: ResearchStatus;
  target: { company: string; url: string | null; resolvedBy: ResolutionMethod };
}

async function runAgentStream(
  body: { goal: string; company?: string; url?: string; domain: Domain; depth: number },
  onEvent: (event: AgentStreamEvent) => void,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch('/api/agent/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // The browser only says "Failed to fetch"; name what actually failed.
    throw new Error(`Could not reach the NexusAgent server (${err instanceof Error ? err.message : String(err)}). Check that it is running and try again.`);
  }
  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as { error?: string; issues?: string[] } | null;
    throw new Error(payload?.issues?.join('; ') || payload?.error || `Request failed with HTTP ${res.status}`);
  }
  if (!res.body) throw new Error('Streaming is not supported by this browser');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) onEvent(JSON.parse(line) as AgentStreamEvent);
    }
    if (done) break;
  }
  if (buffer.trim()) onEvent(JSON.parse(buffer) as AgentStreamEvent);
}

const inputClass = 'mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-indigo-400';
const labelClass = 'text-xs font-medium uppercase tracking-wide text-slate-500';

export default function AgentSimulator() {
  const [company, setCompany] = useState(EXAMPLES[0].company);
  const [url, setUrl] = useState(EXAMPLES[0].url);
  const [goal, setGoal] = useState(EXAMPLES[0].goal);
  const [domain, setDomain] = useState<Domain>(EXAMPLES[0].domain);
  const [depth, setDepth] = useState(2);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<PlanStep[]>([]);
  const [traces, setTraces] = useState<NodeTrace[]>([]);
  const [result, setResult] = useState<AgentRunResponse | null>(null);
  const [selected, setSelected] = useState<NodeId>('planner');

  const latestByNode = useMemo(() => {
    const map = new Map<NodeId, NodeTrace>();
    for (const trace of traces) map.set(trace.node, trace);
    return map;
  }, [traces]);

  const lastCritic = latestByNode.get('critic');
  const lastSynth = latestByNode.get('synthesizer');
  const revisionLoopUsed = traces.some((t) => t.node === 'synthesizer' && t.cycle > 1);
  const retrievalDetail = latestByNode.get('retrieval')?.detail as RetrievalDetail | undefined;

  const statusOf = (node: NodeMeta): NodeStatus => {
    const trace = latestByNode.get(node.id);
    if (running) {
      const criticFailed = lastCritic && isCriticReport(lastCritic.detail) && lastCritic.detail.status === 'fail';
      if (node.id === 'synthesizer' && criticFailed && lastSynth && lastCritic && lastSynth.cycle <= lastCritic.cycle) return 'running';
      if (node.id === 'critic' && lastSynth && lastCritic && lastSynth.cycle > lastCritic.cycle) return 'running';
      if (!trace && node.deps.every((d) => latestByNode.has(d))) return 'running';
    }
    // Partial research ran live but is incomplete; never show it as fully live.
    if (node.id === 'retrieval' && trace?.mode === 'live' && retrievalDetail?.status === 'partial') return 'partial';
    return trace ? trace.mode : 'idle';
  };

  const applyExample = (id: string) => {
    const example = EXAMPLES.find((e) => e.id === id);
    if (!example) return;
    setCompany(example.company);
    setUrl(example.url);
    setGoal(example.goal);
    setDomain(example.domain);
  };

  const canRun = goal.trim().length >= 10 && (company.trim().length > 0 || url.trim().length > 0);

  const run = async () => {
    setRunning(true);
    setError(null);
    setPlan([]);
    setTraces([]);
    setResult(null);
    setSelected('planner');
    try {
      await runAgentStream(
        { goal, domain, depth, ...(company.trim() ? { company: company.trim() } : {}), ...(url.trim() ? { url: url.trim() } : {}) },
        (event) => {
          if (event.type === 'plan') setPlan(event.plan);
          else if (event.type === 'trace') setTraces((prev) => [...prev, event.trace]);
          else if (event.type === 'result') {
            setResult(event.result);
            setTraces(event.result.traces);
            setPlan(event.result.plan);
          } else setError(event.message);
        },
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const selectedTraces = traces.filter((t) => t.node === selected);
  const selectedMeta = NODES.find((n) => n.id === selected) ?? NODES[0];
  const telemetry = result?.telemetry;
  const liveTokens = traces.reduce((s, t) => s + t.inputTokens + t.outputTokens, 0);
  const target = result?.report.company ?? retrievalDetail?.target;
  const researchStatus = result?.report.researchStatus ?? retrievalDetail?.status;

  return (
    <div className="space-y-6">
      {/* grid-cols-1 + min-w-0 keep wide children (the DAG svg) scrolling inside their box instead of widening the page. */}
      <section className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Controls */}
        <div className="min-w-0 space-y-4 rounded-xl border border-slate-800 bg-slate-900/50 p-5 lg:col-span-4">
          <div>
            <h1 className="text-lg font-semibold text-white">Deep research</h1>
            <p className="mt-1 text-sm text-slate-400">Name a company or paste its public URL. The agent forms hypotheses, then tests them against its live web pages.</p>
          </div>

          <div className="flex flex-wrap gap-2">
            {EXAMPLES.map((example) => (
              <button
                key={example.id}
                type="button"
                onClick={() => applyExample(example.id)}
                disabled={running}
                className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-400 transition-colors hover:border-slate-500 hover:text-slate-200 disabled:opacity-50"
              >
                {example.label}
              </button>
            ))}
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
            <label className="block">
              <span className={labelClass}>Company</span>
              <input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="e.g. Stripe" maxLength={120} disabled={running} className={inputClass} />
            </label>
            <label className="block">
              <span className={labelClass}>Public URL (primary source)</span>
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="e.g. https://stripe.com" maxLength={2048} disabled={running} className={inputClass} inputMode="url" />
            </label>
          </div>
          <p className="-mt-2 text-xs text-slate-500">With only a name, the agent tries to identify the official site and shows which source it selected.</p>

          <label className="block">
            <span className={labelClass}>Goal</span>
            <textarea value={goal} onChange={(e) => setGoal(e.target.value)} rows={4} maxLength={2000} disabled={running} className={`${inputClass} resize-y`} />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className={labelClass}>Domain</span>
              <select value={domain} onChange={(e) => setDomain(e.target.value as Domain)} disabled={running} className={inputClass}>
                {DOMAINS.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className={labelClass}>Max critic cycles: {depth}</span>
              <input type="range" min={1} max={MAX_CYCLES} value={depth} onChange={(e) => setDepth(Number(e.target.value))} disabled={running} className="mt-3 w-full accent-indigo-400" />
            </label>
          </div>

          <button
            type="button"
            onClick={run}
            disabled={running || !canRun}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-500 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-indigo-400 disabled:cursor-not-allowed disabled:bg-slate-700"
          >
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {running ? 'Investigating…' : 'Run investigation'}
          </button>

          {error && (
            <div className="flex gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              {error}
            </div>
          )}
          {result && result.warnings.length > 0 && (
            <ul className="space-y-1.5 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-200">
              {result.warnings.map((w, i) => (
                <li key={i} className="flex gap-2">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {w}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Target, telemetry, DAG, inspector */}
        <div className="min-w-0 space-y-4 lg:col-span-8">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-slate-800 bg-slate-900/50 px-4 py-3 text-sm">
            <span className="flex items-center gap-1.5 text-slate-200">
              <Building2 className="h-4 w-4 text-indigo-300" />
              {target?.company || company || '—'}
            </span>
            <span className="flex min-w-0 items-center gap-1.5 text-slate-400">
              <Link2 className="h-4 w-4 shrink-0" />
              {target?.url ? (
                <a href={target.url} target="_blank" rel="noreferrer" className="truncate text-indigo-300 hover:underline">
                  {target.url}
                </a>
              ) : (
                <span className="truncate">{running ? 'Resolving…' : url || 'not provided'}</span>
              )}
            </span>
            {target && <span className="text-xs text-slate-500">{RESOLUTION_LABEL[target.resolvedBy]}</span>}
            <span className="ml-auto flex flex-wrap gap-2">
              {researchStatus && <ResearchBadge status={researchStatus} />}
              {result && <CriticBadge critic={result.critic} />}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat icon={Timer} label="Total latency" value={telemetry ? formatMs(telemetry.totalLatencyMs) : running ? '…' : '—'} hint="Target: under 45 s" />
            <Stat icon={Gauge} label="P95 node latency" value={telemetry ? formatMs(telemetry.p95LatencyMs) : '—'} />
            <Stat
              icon={Zap}
              label="Tokens in / out"
              value={telemetry ? `${telemetry.inputTokens.toLocaleString()} / ${telemetry.outputTokens.toLocaleString()}` : running ? liveTokens.toLocaleString() : '—'}
            />
            <Stat icon={Coins} label="Cost (list-price eq.)" value={telemetry ? formatUsd(telemetry.costUsd) : '—'} hint="Free Tier is billed $0" />
            <Stat icon={Globe} label="Sources ok / failed" value={telemetry ? `${telemetry.sourcesOk} / ${telemetry.sourcesFailed}` : '—'} />
            <Stat
              icon={BrainCircuit}
              label="Gemini"
              value={telemetry ? `${telemetry.gemini.quotaExhausted ? 'quota exhausted (429)' : telemetry.llmMode} · ${telemetry.llmCalls} calls` : '—'}
              hint={telemetry ? `${telemetry.model} · ${telemetry.gemini.status}` : undefined}
              wrap
            />
            <Stat
              icon={ShieldCheck}
              label="Critic"
              value={result ? `${result.critic.status.replace(/_/g, ' ')} · ${result.critic.llmJudge === 'live' ? 'rules + judge' : 'rules only'}` : '—'}
              hint={result?.critic.llmJudgeUnavailableReason}
              wrap
            />
            <Stat icon={Repeat} label="Critic cycles" value={telemetry ? `${telemetry.cycles} / ${telemetry.maxCycles}` : '—'} />
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-white">Execution DAG</h2>
              <div className="flex gap-3 text-[11px]">
                {(Object.keys(STATUS_STYLE) as NodeStatus[]).map((s) => (
                  <span key={s} className="flex items-center gap-1 text-slate-400">
                    <span className="h-2 w-2 rounded-full" style={{ background: STATUS_STYLE[s].stroke }} />
                    {STATUS_STYLE[s].label}
                  </span>
                ))}
              </div>
            </div>
            <div className="scrollbar-thin overflow-x-auto">
              <svg viewBox="0 0 860 240" className="h-auto w-full min-w-[640px]" role="img" aria-label="Agent execution graph">
                <defs>
                  <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                    <path d="M0,0 L10,5 L0,10 z" fill="#475569" />
                  </marker>
                  <marker id="arrow-revise" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                    <path d="M0,0 L10,5 L0,10 z" fill="#a78bfa" />
                  </marker>
                </defs>
                {NODES.slice(1).map((node, i) => {
                  const prev = NODES[i];
                  return (
                    <line
                      key={node.id}
                      x1={prev.x + NODE_W / 2}
                      y1={NODE_Y}
                      x2={node.x - NODE_W / 2 - 4}
                      y2={NODE_Y}
                      stroke={latestByNode.has(node.id) ? '#64748b' : '#1e293b'}
                      strokeWidth={2}
                      markerEnd="url(#arrow)"
                    />
                  );
                })}
                <path
                  d="M 770 118 C 770 40, 600 40, 600 112"
                  fill="none"
                  stroke={revisionLoopUsed ? '#a78bfa' : '#312e81'}
                  strokeWidth={2}
                  strokeDasharray="6 5"
                  markerEnd="url(#arrow-revise)"
                />
                <text x="618" y="48" fill={revisionLoopUsed ? '#c4b5fd' : '#4c4785'} fontSize="11">
                  revise ≤ {MAX_CYCLES} cycles
                </text>
                {NODES.map((node) => {
                  const status = statusOf(node);
                  const style = STATUS_STYLE[status];
                  const trace = latestByNode.get(node.id);
                  const Icon = node.icon;
                  return (
                    <g
                      key={node.id}
                      transform={`translate(${node.x - NODE_W / 2}, ${NODE_Y - NODE_H / 2})`}
                      onClick={() => setSelected(node.id)}
                      className="cursor-pointer"
                      role="button"
                      aria-label={`Inspect ${node.label}`}
                    >
                      <motion.rect
                        width={NODE_W}
                        height={NODE_H}
                        rx={12}
                        fill={style.fill}
                        stroke={selected === node.id ? '#a5b4fc' : style.stroke}
                        strokeWidth={selected === node.id ? 2.5 : 1.5}
                        animate={status === 'running' ? { opacity: [1, 0.55, 1] } : { opacity: 1 }}
                        transition={status === 'running' ? { duration: 1.1, repeat: Infinity } : { duration: 0.2 }}
                      />
                      <foreignObject x={10} y={8} width={NODE_W - 20} height={NODE_H - 16}>
                        <div className="flex h-full items-center gap-2">
                          <Icon className={`h-5 w-5 shrink-0 ${style.text}`} />
                          <div className="min-w-0 leading-tight">
                            <p className="truncate text-[13px] font-semibold text-slate-100">{node.label}</p>
                            <p className="truncate text-[10.5px] text-slate-400">
                              {trace ? `${formatMs(trace.latencyMs)}${trace.cycle > 1 ? ` · c${trace.cycle}` : ''}` : node.role}
                            </p>
                          </div>
                        </div>
                      </foreignObject>
                    </g>
                  );
                })}
              </svg>
            </div>
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
            <div className="mb-3 flex items-center gap-2">
              <selectedMeta.icon className="h-4 w-4 text-indigo-300" />
              <h2 className="text-sm font-semibold text-white">Node inspector · {selectedMeta.label}</h2>
            </div>
            {plan.filter((s) => s.node === selected).length > 0 && (
              <ul className="mb-3 space-y-1 text-xs text-slate-400">
                {plan
                  .filter((s) => s.node === selected)
                  .map((s) => (
                    <li key={s.id}>
                      <span className="font-mono text-slate-500">{s.id}</span> {s.title}
                      {s.dependsOn.length > 0 && <span className="text-slate-600"> ← {s.dependsOn.join(', ')}</span>}
                    </li>
                  ))}
              </ul>
            )}
            {selectedTraces.length === 0 ? (
              <p className="text-sm text-slate-500">{running ? 'Waiting for this node…' : 'Run an investigation, then select a node to inspect its trace.'}</p>
            ) : (
              <div className="space-y-3">
                {selectedTraces.map((trace) => (
                  <div key={trace.id} className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className={`rounded px-1.5 py-0.5 font-medium ${trace.mode === 'live' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-sky-500/15 text-sky-300'}`}>{trace.mode}</span>
                      <span className="text-slate-400">cycle {trace.cycle}</span>
                      <span className="text-slate-400">· {formatMs(trace.latencyMs)}</span>
                      <span className="text-slate-400">
                        · {trace.inputTokens} in / {trace.outputTokens} out
                      </span>
                      <span className="text-slate-400">· {formatUsd(trace.costUsd)}</span>
                      <span className="text-slate-500">· +{formatMs(trace.startOffsetMs)}</span>
                    </div>
                    <p className="mt-2 text-sm text-slate-200">{trace.summary}</p>
                    {trace.fallbackReason && <p className="mt-1 text-xs text-sky-300/80">Fallback reason: {trace.fallbackReason}</p>}
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-300">Raw output</summary>
                      <pre className="scrollbar-thin mt-2 max-h-64 overflow-auto rounded bg-slate-950 p-2 font-mono text-[11px] text-slate-300">{JSON.stringify(trace.detail, null, 2)}</pre>
                    </details>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>

      {result && <ResearchReport key={result.runId} result={result} />}
    </div>
  );
}

function Stat({ icon: Icon, label, value, hint, wrap = false }: { icon: LucideIcon; label: string; value: string; hint?: string; wrap?: boolean }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/50 px-3 py-2.5" title={hint}>
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-slate-500">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      {/* Status values (e.g. "quota exhausted (429)") must stay fully readable, so they wrap instead of truncating. */}
      <p className={`mt-1 font-mono text-sm text-slate-100 ${wrap ? 'break-words' : 'truncate'}`}>{value}</p>
    </div>
  );
}
