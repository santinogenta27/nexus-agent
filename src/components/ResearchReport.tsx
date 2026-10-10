import { useState } from 'react';
import type { ReactNode } from 'react';
import { motion } from 'motion/react';
import { AlertTriangle, BookOpenCheck, CheckCircle2, CircleSlash, Cpu, ExternalLink, FileSearch, Lightbulb, ShieldAlert, ShieldCheck, XCircle } from 'lucide-react';
import type {
  AgentRunResponse,
  CheckStatus,
  CriticReport,
  Evidence,
  EvidenceCoverage,
  GeminiStatus,
  HypothesisVerdict,
  LlmFailureKind,
  ModelContext,
  ResearchStatus,
  SourceRecord,
} from '../types/agent';
import CopyButton from './CopyButton';

export const RESEARCH_LABEL: Record<ResearchStatus, { label: string; className: string; hint: string }> = {
  live: { label: 'Live Research', className: 'bg-emerald-500/15 text-emerald-300 ring-emerald-400/40', hint: 'All sources were fetched and parsed from the live web.' },
  partial: { label: 'Partial Research', className: 'bg-amber-500/15 text-amber-300 ring-amber-400/40', hint: 'Some sources failed or key pages were missing.' },
  fallback: {
    label: 'Fallback · no web evidence',
    className: 'bg-rose-500/15 text-rose-300 ring-rose-400/40',
    hint: 'No source could be retrieved and parsed into evidence. Nothing in this report comes from the web.',
  },
};

export function ResearchBadge({ status }: { status: ResearchStatus }) {
  const s = RESEARCH_LABEL[status];
  return (
    <span title={s.hint} className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ${s.className}`}>
      {s.label}
    </span>
  );
}

const CRITIC_STYLE: Record<CriticReport['status'], string> = {
  pass: 'bg-emerald-500/15 text-emerald-300 ring-emerald-400/40',
  pass_with_limitations: 'bg-amber-500/15 text-amber-300 ring-amber-400/40',
  fail: 'bg-rose-500/15 text-rose-300 ring-rose-400/40',
};

/** Says which validation actually ran: deterministic rule checks alone, or rule checks plus the Gemini judge. */
export function criticLabel(critic: Pick<CriticReport, 'status' | 'llmJudge'>): string {
  const scope = critic.llmJudge === 'live' ? 'rules + LLM judge' : 'rule checks only · LLM judge not run';
  if (critic.status === 'fail') return `Critic: failed (${scope})`;
  if (critic.status === 'pass_with_limitations') return `Critic: passed with limitations (${scope})`;
  return critic.llmJudge === 'live' ? 'Critic: validated (rules + LLM judge)' : 'Critic: rule checks passed · LLM judge not run';
}

export function CriticBadge({ critic }: { critic: Pick<CriticReport, 'status' | 'llmJudge' | 'llmJudgeUnavailableReason'> }) {
  // Green is reserved for full validation (rules + LLM judge); rules-only passes use a neutral colour.
  const style = critic.status === 'pass' && critic.llmJudge !== 'live' ? 'bg-sky-500/15 text-sky-300 ring-sky-400/40' : CRITIC_STYLE[critic.status];
  return (
    <span title={critic.llmJudgeUnavailableReason} className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ${style}`}>
      {criticLabel(critic)}
    </span>
  );
}

const COVERAGE_STYLE: Record<EvidenceCoverage, string> = {
  complete: 'bg-slate-700/60 text-slate-200',
  partial: 'bg-slate-700/60 text-slate-200',
  low: 'bg-slate-700/60 text-slate-300',
  none: 'bg-slate-800 text-slate-400',
};

const GEMINI_KIND_LABEL: Record<LlmFailureKind, string> = {
  quota: 'quota exhausted (HTTP 429)',
  rate_guard: 'local rate guard',
  timeout: 'timed out',
  budget: 'run time budget exhausted',
  not_configured: 'no API key',
  invalid_output: 'invalid output',
  skipped: 'skipped',
  error: 'request failed',
};

/** States plainly whether Gemini contributed to this run, and why not when it did not. */
export function GeminiNotice({ gemini }: { gemini: GeminiStatus }) {
  if (gemini.status === 'live') return null;
  const quota = gemini.quotaExhausted;
  const nodes = gemini.failures.map((f) => `${f.node}${f.cycle > 1 ? ` (cycle ${f.cycle})` : ''}: ${GEMINI_KIND_LABEL[f.kind]}`);
  return (
    <div className={`flex gap-2 rounded-lg border p-3 text-sm ${quota ? 'border-rose-500/40 bg-rose-500/10 text-rose-200' : 'border-sky-500/30 bg-sky-500/5 text-sky-200'}`}>
      <Cpu className="mt-0.5 h-4 w-4 shrink-0" />
      <div>
        <p className="font-medium">
          {quota
            ? 'Gemini could not be used: quota exhausted (HTTP 429).'
            : gemini.status === 'not_configured'
              ? 'Gemini is not configured: no API key.'
              : gemini.status === 'unavailable'
                ? 'Gemini was not used in this run.'
                : 'Gemini was only partly used in this run.'}
        </p>
        <p className="mt-0.5 text-xs opacity-90">
          The affected steps ran on the deterministic engine — nothing in them was written or judged by Gemini. {nodes.join(' · ')}
        </p>
      </div>
    </div>
  );
}

const VERDICT_STYLE: Record<HypothesisVerdict, string> = {
  supported: 'text-emerald-300',
  partially_supported: 'text-amber-300',
  refuted: 'text-rose-300',
  inconclusive: 'text-slate-400',
};

const VERDICT_LABEL: Record<HypothesisVerdict, string> = {
  supported: 'Supported',
  partially_supported: 'Partially supported',
  refuted: 'Refuted',
  inconclusive: 'Inconclusive — not confirmed',
};

const CHECK_ICON: Record<CheckStatus, { icon: typeof CheckCircle2; className: string }> = {
  pass: { icon: CheckCircle2, className: 'text-emerald-400' },
  warn: { icon: AlertTriangle, className: 'text-amber-400' },
  fail: { icon: XCircle, className: 'text-rose-400' },
  skipped: { icon: CircleSlash, className: 'text-slate-500' },
};

function Missing() {
  return <span className="text-slate-600">not stated</span>;
}

function Section({ title, children, icon: Icon }: { title: string; children: ReactNode; icon?: typeof FileSearch }) {
  return (
    // min-w-0: wide tables scroll inside the section instead of widening the page on small screens.
    <section className="min-w-0 space-y-3">
      <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
        {Icon && <Icon className="h-4 w-4 text-indigo-300" />}
        {title}
      </h3>
      {children}
    </section>
  );
}

/** Evidence ids rendered as chips; clicking one reveals the verbatim snippet and its source URL. */
function EvidenceRefs({ ids, evidence }: { ids: string[]; evidence: Map<string, Evidence> }) {
  const [open, setOpen] = useState<string | null>(null);
  if (ids.length === 0) return <span className="text-xs text-slate-600">no evidence</span>;
  const item = open ? evidence.get(open) : undefined;
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1">
        {ids.map((id) => {
          const known = evidence.has(id);
          return (
            <button
              key={id}
              type="button"
              onClick={() => setOpen(open === id ? null : id)}
              disabled={!known}
              title={known ? 'Show source snippet' : 'Unknown evidence id'}
              className={`rounded px-1.5 py-0.5 font-mono text-[11px] ${
                !known ? 'bg-rose-500/15 text-rose-300 line-through' : open === id ? 'bg-indigo-500 text-white' : 'bg-indigo-500/15 text-indigo-200 hover:bg-indigo-500/25'
              }`}
            >
              {id}
            </button>
          );
        })}
      </div>
      {item && (
        <div className="rounded-md border border-slate-800 bg-slate-950 p-2 text-xs">
          {(item.context || item.contextual === false) && (
            <p className="mb-1 text-[11px] text-slate-500">
              {item.context ? `Under "${item.context}"` : ''}
              {item.contextual === false ? `${item.context ? ' · ' : ''}generic call-to-action, not counted as friction` : ''}
            </p>
          )}
          <p className="text-slate-200">“{item.snippet}”</p>
          <a href={item.url} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 break-all text-indigo-300 hover:underline">
            {item.sourceId} · {item.url} <ExternalLink className="h-3 w-3 shrink-0" />
          </a>
        </div>
      )}
    </div>
  );
}

const LOW_CONTENT_LABEL: Record<NonNullable<SourceRecord['lowContentReason']>, string> = {
  blocked: 'blocked or bot check',
  error_page: 'error page',
  client_rendered: 'content built by JavaScript',
  empty: 'almost no readable text',
};

/** Background from Gemini's training knowledge: visually separate from evidence and explicitly unverified. */
function ModelContextPanel({ context }: { context: ModelContext }) {
  return (
    <section aria-label="General model knowledge" className="min-w-0 space-y-2 rounded-lg border border-dashed border-amber-500/40 bg-amber-500/5 p-4">
      <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-amber-300">
        <Cpu className="h-4 w-4" aria-hidden="true" />
        General model knowledge — not verified on the web
      </h3>
      <p className="text-xs text-amber-200/80">{context.reason}</p>
      {context.status === 'provided' ? (
        <>
          <ul className="list-inside list-disc space-y-1 text-sm text-slate-300">
            {context.statements.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
          <p className="text-[11px] text-slate-500">
            From Gemini's training data, not from retrieved pages. No citations, not used as evidence for any finding, verdict or metric; sentences with figures were removed.
          </p>
        </>
      ) : (
        <p className="text-xs text-slate-400">No model background was added.</p>
      )}
    </section>
  );
}

const UNKNOWN_PRODUCT = 'Unknown product (no enclosing heading)';

interface TariffRow {
  key: string;
  product: string | null;
  /** Sub-section under the product, e.g. "Disputes" for "Payments › Disputes". */
  section: string | null;
  item: string | null;
  price: string;
  unit: string | null;
  period: string | null;
  terms: string[];
  evidenceId: string;
}

/** Every tariff, grouped by the product it is published under. Collapsed groups stay in the page, nothing is dropped. */
function PricingByProduct({ report, evidence }: { report: AgentRunResponse['report']; evidence: Map<string, Evidence> }) {
  // "Payments › Disputes" → product "Payments", section "Disputes"; a single heading is the product itself.
  const split = (path: string | null) => {
    if (!path) return { product: null, section: null };
    const [head, ...rest] = path.split(' › ');
    return { product: head, section: rest.length ? rest.join(' › ') : null };
  };
  const rows: TariffRow[] = [
    ...report.percentFees.map((f, i) => ({
      key: `fee-${f.evidenceId}-${i}`,
      ...split(f.product),
      item: f.item,
      price: `${f.percent}%${f.fixedAmount !== null ? ` + ${f.fixedAmount} ${f.fixedCurrency}` : ''}`,
      unit: f.unit,
      period: null,
      terms: [],
      evidenceId: f.evidenceId,
    })),
    ...report.pricing.map((p, i) => ({
      key: `price-${p.evidenceId}-${i}`,
      ...split(p.product),
      item: p.item,
      price: `${p.amount} ${p.currency}`,
      unit: p.unit,
      period: p.period,
      terms: p.terms,
      evidenceId: p.evidenceId,
    })),
  ];
  const groups = new Map<string, TariffRow[]>();
  for (const row of rows) {
    const name = row.product ?? UNKNOWN_PRODUCT;
    groups.set(name, [...(groups.get(name) ?? []), row]);
  }
  // Known products first (page order), the unknown bucket last.
  const ordered = [...groups.entries()].sort((a, b) => Number(a[0] === UNKNOWN_PRODUCT) - Number(b[0] === UNKNOWN_PRODUCT));
  const openByDefault = ordered.length <= 6 ? ordered.length : 3;

  return (
    <div className="space-y-2">
      <p className="text-[11px] text-slate-500">
        {rows.length} tariffs in {ordered.length} product groups. "not stated" means the page does not state that field next to the price; it is never inferred.
      </p>
      {ordered.map(([name, items], index) => (
        <details key={name} open={index < openByDefault} className="rounded-lg border border-slate-800 bg-slate-950/60">
          <summary className={`cursor-pointer select-none px-3 py-2 text-xs font-medium ${name === UNKNOWN_PRODUCT ? 'text-amber-300' : 'text-slate-200'}`}>
            {name} <span className="font-normal text-slate-500">· {items.length}</span>
          </summary>
          <div className="scrollbar-thin overflow-x-auto px-3 pb-2">
            <table className="w-full min-w-[560px] text-left text-xs">
              <thead className="text-slate-500">
                <tr>
                  <th className="py-1 pr-2 font-medium">Section</th>
                  <th className="py-1 pr-2 font-medium">Line item</th>
                  <th className="py-1 pr-2 font-medium">Price</th>
                  <th className="py-1 pr-2 font-medium">Per (unit)</th>
                  <th className="py-1 pr-2 font-medium">Period</th>
                  <th className="py-1 pr-2 font-medium">Terms</th>
                  <th className="py-1 font-medium">Source</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800 align-top text-slate-300">
                {items.map((row) => {
                  const ev = evidence.get(row.evidenceId);
                  return (
                    <tr key={row.key}>
                      <td className="py-1.5 pr-2">{row.section ?? <span className="text-slate-600">—</span>}</td>
                      <td className="py-1.5 pr-2">{row.item ?? <Missing />}</td>
                      <td className="py-1.5 pr-2 font-mono whitespace-nowrap">{row.price}</td>
                      <td className="py-1.5 pr-2">{row.unit ?? <Missing />}</td>
                      <td className="py-1.5 pr-2">{row.period ?? <Missing />}</td>
                      <td className="py-1.5 pr-2">{row.terms.length ? row.terms.join(', ') : <Missing />}</td>
                      <td className="py-1.5 whitespace-nowrap">
                        {ev ? (
                          <a href={ev.url} target="_blank" rel="noreferrer" title={ev.snippet} className="inline-flex items-center gap-1 font-mono text-indigo-200 hover:underline">
                            {row.evidenceId} <ExternalLink className="h-3 w-3" />
                          </a>
                        ) : (
                          <span className="font-mono text-rose-300">{row.evidenceId}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </details>
      ))}
    </div>
  );
}

export default function ResearchReport({ result }: { result: AgentRunResponse }) {
  const { report, critic } = result;
  const evidence = new Map(report.evidence.map((e) => [e.id, e]));
  const features = report.evidence.filter((e) => e.kind === 'feature');
  const okSources = report.sources.filter((s) => s.status === 'ok');
  const failedSources = report.sources.filter((s) => s.status !== 'ok');

  return (
    <motion.article initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="space-y-8 rounded-xl border border-slate-800 bg-slate-900/50 p-6">
      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <ResearchBadge status={report.researchStatus} />
          <CriticBadge critic={critic} />
        </div>
        <h2 className="text-xl font-semibold text-white">Intelligence report · {report.company.company}</h2>
        <GeminiNotice gemini={result.telemetry.gemini} />
        {report.researchStatus === 'fallback' && (
          <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">
            This is a fallback report. No public source could be retrieved and parsed, so it contains no web findings — only the hypotheses to test and the limitations.
          </p>
        )}
        {report.researchStatus === 'partial' && (
          <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-200">
            Partial research:{' '}
            {[
              failedSources.length > 0 ? `${failedSources.length} of ${report.sources.length} sources failed or were empty` : '',
              okSources.some((s) => s.kind === 'pricing') ? '' : 'no pricing page was retrieved',
            ]
              .filter(Boolean)
              .join('; ')}
            . Findings below rely only on the sources marked as retrieved.
          </p>
        )}
        <p className="text-sm leading-relaxed text-slate-300">{report.executiveSummary}</p>
        {report.churn.status === 'provisional' && (
          <p className="flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-200">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            Provisional churn diagnosis — {report.churn.note}
          </p>
        )}
      </header>

      <Section title="Company profile & value proposition" icon={FileSearch}>
        <p className="text-sm leading-relaxed text-slate-300">{report.companyProfile}</p>
      </Section>

      {report.modelContext.status !== 'not_needed' && <ModelContextPanel context={report.modelContext} />}

      <Section title="Deductive hypotheses" icon={Lightbulb}>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {report.hypotheses.map((h) => (
            <div key={h.id} className="space-y-3 rounded-lg border border-slate-800 bg-slate-950/60 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-slate-500">{h.id}</span>
                <span className="text-xs font-semibold uppercase tracking-wide text-slate-300">{h.area}</span>
                <span className="ml-auto text-[11px] text-slate-500">hypothesis — not a fact</span>
              </div>
              <p className="text-sm text-slate-200">{h.statement}</p>
              <dl className="grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-md bg-slate-900 p-2">
                  <dt className="text-slate-500">Evidence coverage</dt>
                  <dd className="mt-0.5">
                    <span className={`rounded px-1.5 py-0.5 font-medium ${COVERAGE_STYLE[h.coverage]}`}>
                      {h.coverage} · {h.categoriesFound.length}/{h.requiredCategories.length}
                    </span>
                  </dd>
                </div>
                <div className="rounded-md bg-slate-900 p-2">
                  <dt className="text-slate-500">Verdict</dt>
                  <dd className={`mt-0.5 font-medium ${VERDICT_STYLE[h.verdict]}`}>
                    {h.verdict === 'inconclusive' ? VERDICT_LABEL.inconclusive : `${VERDICT_LABEL[h.verdict]} · ${h.verdictConfidence ?? '—'} confidence`}
                  </dd>
                </div>
              </dl>
              <p className="text-xs text-slate-400">{h.verdictRationale}</p>
              <div className="space-y-1.5 text-xs">
                <p className="text-slate-500">{h.verdict === 'inconclusive' ? 'Related evidence' : 'Supporting evidence'}</p>
                <EvidenceRefs ids={h.verdictEvidence.length ? h.verdictEvidence : h.evidenceFound} evidence={evidence} />
                {h.verdictContradicting.length > 0 && (
                  <>
                    <p className="text-rose-300/80">Contradicting evidence</p>
                    <EvidenceRefs ids={h.verdictContradicting} evidence={evidence} />
                  </>
                )}
                {h.verdictMissing.length > 0 && (
                  <p className="text-slate-500">
                    <span className="text-slate-400">Missing:</span> {h.verdictMissing.join('; ')}
                  </p>
                )}
              </div>
              <div className="space-y-1 text-xs">
                <p className="text-slate-500">Evidence needed</p>
                <ul className="space-y-0.5">
                  {h.requiredCategories.map((c) => (
                    <li key={c} className={`flex gap-1.5 ${h.categoriesFound.includes(c) ? 'text-emerald-300' : 'text-slate-500'}`}>
                      {h.categoriesFound.includes(c) ? <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0" /> : <XCircle className="mt-0.5 h-3 w-3 shrink-0" />}
                      {c}
                    </li>
                  ))}
                </ul>
              </div>
              <p className="text-xs text-slate-500">{h.coverageJustification}</p>
              <p className="text-xs text-slate-400">
                <span className="text-slate-500">Would be refuted by:</span> {h.refutedBy}
              </p>
            </div>
          ))}
        </div>
      </Section>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
        <Section title={`Observed facts (${report.confirmedFindings.length})`} icon={BookOpenCheck}>
          {report.confirmedFindings.length === 0 ? (
            <p className="text-sm text-slate-500">No findings could be confirmed from retrieved sources.</p>
          ) : (
            <ul className="space-y-3">
              {report.confirmedFindings.map((f, i) => (
                <li key={i} className="space-y-1.5 text-sm text-slate-200">
                  {f.statement}
                  <EvidenceRefs ids={f.evidenceIds} evidence={evidence} />
                </li>
              ))}
            </ul>
          )}
        </Section>
        <div className="space-y-8">
          <Section title={`Inferences — unverified (${report.inferences.length})`}>
            {report.inferences.length === 0 ? (
              <p className="text-sm text-slate-500">No inferences drawn.</p>
            ) : (
              <ul className="space-y-3">
                {report.inferences.map((f, i) => (
                  <li key={i} className="space-y-1 text-sm">
                    <p className="text-slate-200">{f.statement}</p>
                    <p className="text-xs text-slate-400">Reasoning: {f.reasoning}</p>
                    <EvidenceRefs ids={f.evidenceIds} evidence={evidence} />
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title="Open questions">
            <ul className="list-inside list-disc space-y-1 text-sm text-slate-400">
              {report.openQuestions.map((q, i) => (
                <li key={i}>{q}</li>
              ))}
            </ul>
          </Section>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
        <Section title={`Products & features (${features.length})`}>
          {features.length === 0 ? (
            <p className="text-sm text-slate-500">No feature statements were extracted.</p>
          ) : (
            <ul className="space-y-1.5 text-sm text-slate-300">
              {features.slice(0, 14).map((f) => (
                <li key={f.id} className="flex gap-2">
                  <span className="font-mono text-[11px] text-slate-500">{f.id}</span>
                  {f.snippet}
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title={`Published pricing (${report.pricing.length + report.percentFees.length})`}>
          {report.pricing.length + report.percentFees.length === 0 ? (
            <p className="text-sm text-slate-500">No published prices were found on retrieved pages.</p>
          ) : (
            <PricingByProduct report={report} evidence={evidence} />
          )}
        </Section>
      </div>

      <Section title="Sandbox metrics — observed vs. calculated">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {report.metrics.map((m) => (
            <div key={m.id} className="rounded-lg border border-slate-800 bg-slate-950/60 p-3" title={`${m.formula} · inputs: ${m.inputs.join(', ') || 'none'}`}>
              <div className="flex items-center justify-between text-[11px]">
                <span className="font-mono text-slate-500">{m.id}</span>
                <span className={m.kind === 'observed' ? 'text-sky-300' : 'text-violet-300'}>{m.kind}</span>
              </div>
              <p className="mt-1 text-xs text-slate-400">{m.label}</p>
              {m.status === 'ok' ? (
                <p className="mt-1 font-mono text-base text-slate-100">
                  {m.value} <span className="text-xs text-slate-500">{m.unit}</span>
                </p>
              ) : (
                <p className="mt-1 text-xs font-medium text-amber-300">Insufficient data</p>
              )}
              <p className="mt-1 text-[11px] text-slate-500">{m.note}</p>
            </div>
          ))}
        </div>
      </Section>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
        {(['risks', 'opportunities'] as const).map((key) => (
          <Section key={key} title={key === 'risks' ? 'Potential risks — unverified hypotheses' : 'Potential opportunities — unverified hypotheses'}>
            {report[key].length === 0 ? (
              <p className="text-sm text-slate-500">None identified from the evidence.</p>
            ) : (
              <ul className="space-y-3">
                {[...report[key]]
                  .sort((a, b) => a.priority.localeCompare(b.priority))
                  .map((r, i) => (
                    <li key={i} className="space-y-1 text-sm">
                      <p className="text-slate-200">
                        <span className="mr-2 rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[11px] text-slate-300">{r.priority}</span>
                        {r.title}
                      </p>
                      <p className="text-xs text-slate-400">{r.detail}</p>
                      <EvidenceRefs ids={r.evidenceIds} evidence={evidence} />
                    </li>
                  ))}
              </ul>
            )}
          </Section>
        ))}
      </div>

      <Section title="Recommendations">
        <div className="scrollbar-thin overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="text-xs text-slate-500">
              <tr>
                <th className="py-1 pr-3 font-medium">Action</th>
                <th className="py-1 pr-3 font-medium">Expected impact</th>
                <th className="py-1 pr-3 font-medium">Effort</th>
                <th className="py-1 pr-3 font-medium">Timeframe</th>
                <th className="py-1 pr-3 font-medium">KPI</th>
                <th className="py-1 font-medium">Tests</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800 align-top text-slate-300">
              {report.recommendations.map((r, i) => (
                <tr key={i}>
                  <td className="py-2 pr-3 text-slate-200">{r.action}</td>
                  <td className="py-2 pr-3 text-xs">{r.expectedImpact}</td>
                  <td className="py-2 pr-3 text-xs">{r.effort}</td>
                  <td className="py-2 pr-3 text-xs">{r.timeframe}</td>
                  <td className="py-2 pr-3 text-xs">{r.kpi}</td>
                  <td className="py-2 font-mono text-xs text-indigo-200">{r.hypothesisId}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Critic validation" icon={ShieldCheck}>
        <p className={`rounded-lg border p-3 text-sm ${critic.llmJudge === 'live' ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-200' : 'border-sky-500/30 bg-sky-500/5 text-sky-200'}`}>
          {critic.llmJudge === 'live'
            ? `${critic.checks.filter((c) => c.id !== 'C9').length} deterministic rule checks plus the Gemini LLM judge (C9) ran on this report.`
            : `Only the ${critic.checks.filter((c) => c.id !== 'C9').length} deterministic rule checks ran. The Gemini LLM judge did not run${critic.llmJudgeUnavailableReason ? `: ${critic.llmJudgeUnavailableReason}` : ''}. Goal fit and contradictions were not assessed by an LLM.`}
        </p>
        <ul className="grid gap-2 md:grid-cols-2">
          {critic.checks.map((c) => {
            const { icon: Icon, className } = CHECK_ICON[c.status];
            return (
              <li key={c.id} className="flex gap-2 rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-sm">
                <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${className}`} />
                <div>
                  <p className="text-slate-200">
                    <span className="font-mono text-xs text-slate-500">{c.id}</span> {c.label}
                  </p>
                  <p className="text-xs text-slate-400">{c.detail}</p>
                </div>
              </li>
            );
          })}
        </ul>
      </Section>

      <Section title={`Sources · ${okSources.length} retrieved · ${failedSources.length} failed`}>
        <ul className="space-y-2">
          {report.sources.map((s) => (
            <li key={s.id} className="rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                {s.status === 'ok' ? <CheckCircle2 className="h-4 w-4 text-emerald-400" /> : <XCircle className="h-4 w-4 text-rose-400" />}
                <span className="font-mono text-xs text-slate-500">{s.id}</span>
                <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[11px] text-slate-300">{s.kind}</span>
                <a href={s.finalUrl ?? s.url} target="_blank" rel="noreferrer" className="break-all text-indigo-300 hover:underline">
                  {s.finalUrl ?? s.url}
                </a>
                <span className="ml-auto text-xs text-slate-500">
                  {s.httpStatus ? `HTTP ${s.httpStatus} · ` : ''}
                  {s.durationMs} ms{s.status === 'ok' ? ` · ${s.textChars.toLocaleString()} chars` : ''}
                </span>
              </div>
              {s.title && <p className="mt-1 text-xs text-slate-400">{s.title}</p>}
              {s.status !== 'ok' && (
                <p className="mt-1 text-xs text-rose-300">
                  {s.status}
                  {s.lowContentReason ? ` (${LOW_CONTENT_LABEL[s.lowContentReason]})` : ''}: {s.error}
                </p>
              )}
              {s.recovery && (
                <p className="mt-1 text-xs text-amber-300">
                  Recovered via {s.recovery.method.replace('_', ' ')}
                  {s.lowContentReason ? ` · page itself: ${LOW_CONTENT_LABEL[s.lowContentReason]}` : ''} — {s.recovery.detail}
                </p>
              )}
              {s.supports.length > 0 && <p className="mt-1 text-xs text-slate-500">Supports: {s.supports.join(' · ')}</p>}
            </li>
          ))}
          {report.sources.length === 0 && <li className="text-sm text-slate-500">No source was attempted.</li>}
        </ul>
        {report.company.candidatesTried.length > 0 && report.company.resolvedBy !== 'user_url' && (
          <div className="text-xs text-slate-500">
            <p>Official-site resolution attempts:</p>
            <ul className="list-inside list-disc">
              {report.company.candidatesTried.map((c) => (
                <li key={c.url}>
                  {c.url} — {c.outcome}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Section>

      <Section title="Limitations" icon={AlertTriangle}>
        <ul className="list-inside list-disc space-y-1 text-sm text-slate-400">
          {report.limitations.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      </Section>

      {report.codeArtifact && (
        <Section title="Reproducible sandbox code">
          <div className="flex justify-end">
            <CopyButton text={report.codeArtifact} />
          </div>
          <pre className="scrollbar-thin max-h-80 overflow-auto rounded-lg border border-slate-800 bg-slate-950 p-3 font-mono text-[12px] text-slate-300">{report.codeArtifact}</pre>
        </Section>
      )}
    </motion.article>
  );
}
