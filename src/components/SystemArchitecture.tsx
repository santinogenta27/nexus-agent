import { Activity, BrainCircuit, Calculator, Globe, Layers, Lock, Scale, ShieldCheck, Sparkles } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

const NODES: { icon: LucideIcon; name: string; tool?: string; body: string }[] = [
  {
    icon: BrainCircuit,
    name: 'Supervisor',
    body: 'Forms three testable hypotheses — product, pricing and friction — adapted to the goal and domain, each with the evidence it needs and the observation that would refute it. Hypotheses are never treated as facts.',
  },
  {
    icon: Globe,
    name: 'Retrieval',
    tool: 'web_research',
    body: 'Uses the URL you give as the primary source, or identifies the official site from the company name and verifies it on the page. Fetches up to 6 relevant pages (home, pricing, product, docs, customers) and extracts verbatim evidence with its source URL.',
  },
  {
    icon: Calculator,
    name: 'Sandbox',
    tool: 'sandbox_python_executor',
    body: 'Validates extracted prices and signals with Zod, then computes observed counts and calculated price levels in an isolated V8 context. Metrics without enough data are reported as insufficient, never estimated.',
  },
  {
    icon: Sparkles,
    name: 'Synthesizer',
    body: 'Writes the intelligence report: profile, products and pricing found, hypothesis verdicts, confirmed findings vs. inferences vs. open questions, prioritised risks and opportunities, and recommendations with impact, effort, timeframe and KPI.',
  },
  {
    icon: Scale,
    name: 'Critic',
    tool: 'eval_critic_judge',
    body: 'Mandatory validation: claims cite retrieved evidence, snippets match fetched content verbatim, calculations reproduce independently, no invented figures, churn stays provisional. Sends structured issues back for up to 3 revision cycles, then strips what still fails and states the limitations.',
  },
];

const PILLARS: { icon: LucideIcon; title: string; items: string[] }[] = [
  {
    icon: Lock,
    title: 'Fetch safety',
    items: [
      'Only http/https to ports 80/443; no credentials in URLs; internal host names rejected.',
      'DNS answers are checked and the socket connects to the checked address, blocking private, loopback, link-local, metadata and other non-public ranges.',
      'Every redirect is re-validated (max 3); 8 s per page, 22 s research budget, 3 MB per response, 3 concurrent requests.',
      'HTML is tokenised, never executed; scripts, styles and embeds are discarded.',
    ],
  },
  {
    icon: ShieldCheck,
    title: 'Honesty guarantees',
    items: [
      'Research status is Live, Partial or Fallback; a fallback is never presented as web research.',
      'Failed sources are reported with their error and never cited.',
      'Facts, calculations, inferences and hypotheses are kept in separate sections.',
      'Without internal data, churn readings are always labelled provisional.',
    ],
  },
  {
    icon: Activity,
    title: 'Observability',
    items: [
      'Per-node status, latency, tokens, cost and live/fallback mode, streamed as NDJSON.',
      'Run-level latency within a 120 s budget, P95 node latency, sources retrieved vs. failed, critic cycles.',
      'Gemini 500/503 errors retried twice (2 s, 4 s) within the run budget; HTTP 429 is never retried and pauses Gemini calls for 60 s; 15 RPM Free Tier guard.',
    ],
  },
  {
    icon: Layers,
    title: 'Stack',
    items: [
      'Gemini via @google/genai, orchestrated with Genkit tools and flows; deterministic engine when no key is set.',
      'Express API with Vite middleware, TypeScript end to end, node-html-parser for HTML.',
      'React 19, Tailwind CSS v4, Motion and Lucide on the frontend.',
    ],
  },
];

const ENDPOINTS: [string, string, string][] = [
  ['GET', '/api/health', 'Server status, Gemini configuration, Genkit tools and flow, rate-limit usage and research limits.'],
  ['POST', '/api/agent/run', 'Body { goal, company?, url?, domain, depth } (company or url required). Returns plan, node traces, telemetry, the intelligence report and the critic validation. Send Accept: application/x-ndjson to stream events.'],
];

export default function SystemArchitecture() {
  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-xl font-semibold text-white">System architecture</h1>
        <p className="mt-1 text-sm text-slate-400">Hypotheses first, evidence second: how an investigation moves through the agent graph.</p>
      </header>

      <section className="rounded-xl border border-slate-800 bg-slate-900/50 p-5">
        <h2 className="text-sm font-semibold text-white">Execution graph</h2>
        <pre className="scrollbar-thin mt-3 overflow-x-auto font-mono text-[12.5px] leading-relaxed text-slate-300">{`Supervisor ──► Retrieval ──► Sandbox ──► Synthesizer ──► Critic
                                              ▲              │
                                              └── revise ≤ 3 ─┘`}</pre>
        <p className="mt-3 text-sm text-slate-400">The only cycle is the Critic's revision edge back to the Synthesizer, capped by the run's depth and the 120-second budget.</p>
      </section>

      <section className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {NODES.map(({ icon: Icon, name, tool, body }) => (
          <div key={name} className="rounded-xl border border-slate-800 bg-slate-900/50 p-5">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
              <Icon className="h-4 w-4 text-indigo-300" />
              {name}
            </h3>
            {tool && <p className="mt-1 font-mono text-[11px] text-indigo-200/80">{tool}</p>}
            <p className="mt-2 text-sm leading-relaxed text-slate-400">{body}</p>
          </div>
        ))}
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        {PILLARS.map(({ icon: Icon, title, items }) => (
          <div key={title} className="rounded-xl border border-slate-800 bg-slate-900/50 p-5">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
              <Icon className="h-4 w-4 text-indigo-300" />
              {title}
            </h3>
            <ul className="mt-3 list-inside list-disc space-y-1.5 text-sm text-slate-400">
              {items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      <section className="rounded-xl border border-slate-800 bg-slate-900/50 p-5">
        <h2 className="text-sm font-semibold text-white">API</h2>
        <dl className="mt-3 divide-y divide-slate-800">
          {ENDPOINTS.map(([method, path, description]) => (
            <div key={path} className="grid gap-1 py-2.5 sm:grid-cols-[220px_1fr]">
              <dt className="font-mono text-xs text-indigo-200">
                {method} {path}
              </dt>
              <dd className="text-sm text-slate-400">{description}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
