import vm from 'node:vm';
import { PercentFeeSchema, PriceObservationSchema } from '../../src/types/agent.ts';
import type { Evidence, FrictionSignal, MetricResult, PercentFee, PriceObservation, ResearchResult, SandboxResult } from '../../src/types/agent.ts';

/** Validated, structured inputs. Only data extracted from retrieved pages ever reaches the sandbox. */
export interface SandboxInput {
  pagesRetrieved: boolean;
  pricingPageRetrieved: boolean;
  prices: PriceObservation[];
  percentFees: PercentFee[];
  customPricingEvidence: string[];
  featureEvidence: string[];
  /** contextual=false marks generic CTA text (e.g. a "Contact sales" header button); it is never counted as friction. */
  friction: { id: string; signal: FrictionSignal; contextual: boolean }[];
}

const SALES_ASSISTED: FrictionSignal[] = ['contact_sales', 'demo_required', 'annual_commitment', 'setup_fee'];
const SALES_STEPS: FrictionSignal[] = ['contact_sales', 'demo_required'];
const SELF_SERVE: FrictionSignal[] = ['free_trial', 'free_plan', 'no_credit_card', 'self_serve_signup'];

export function buildSandboxInput(research: ResearchResult): { input: SandboxInput; rejected: string[] } {
  const rejected: string[] = [];
  const evidenceIds = new Set(research.evidence.map((e) => e.id));
  const seen = new Set<string>();

  const prices: PriceObservation[] = [];
  for (const raw of research.prices) {
    const parsed = PriceObservationSchema.safeParse(raw);
    if (!parsed.success) {
      rejected.push(`Price from ${raw.evidenceId} rejected: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
      continue;
    }
    const p = parsed.data;
    if (!evidenceIds.has(p.evidenceId)) {
      rejected.push(`Price ${p.amount} rejected: evidence ${p.evidenceId} not found`);
      continue;
    }
    if (p.amount > 1_000_000) {
      rejected.push(`Price ${p.amount} ${p.currency} from ${p.evidenceId} rejected: implausibly large`);
      continue;
    }
    const key = [p.amount, p.currency, p.product, p.item, p.unit, p.period].join('|');
    if (seen.has(key)) continue; // the same tariff repeated in a comparison table
    seen.add(key);
    prices.push(p);
  }

  const percentFees: PercentFee[] = [];
  for (const raw of research.percentFees) {
    const parsed = PercentFeeSchema.safeParse(raw);
    if (parsed.success && evidenceIds.has(parsed.data.evidenceId)) percentFees.push(parsed.data);
    else rejected.push(`Percentage fee from ${raw.evidenceId} rejected: invalid or unreferenced`);
  }

  const byKind = (kind: Evidence['kind']) => research.evidence.filter((e) => e.kind === kind).map((e) => e.id);
  return {
    input: {
      pagesRetrieved: research.sources.some((s) => s.status === 'ok'),
      pricingPageRetrieved: research.sources.some((s) => s.kind === 'pricing' && s.status === 'ok'),
      prices,
      percentFees,
      customPricingEvidence: byKind('custom_pricing'),
      featureEvidence: byKind('feature'),
      friction: research.evidence
        .filter((e) => e.kind === 'friction' && e.signal)
        .map((e) => ({ id: e.id, signal: e.signal as FrictionSignal, contextual: e.contextual !== false })),
    },
    rejected,
  };
}

/** The computation executed inside the isolated V8 context. Plain JavaScript, no host objects besides console. */
const METRICS_JS = `
const round = (n) => Math.round(n * 100) / 100;
const metric = (id, label, kind, value, unit, formula, inputs, note) => ({
  id, label, kind, status: value === null ? 'insufficient_data' : 'ok', value: value === null ? null : round(value), unit, formula, inputs, note,
});
const SALES = ['contact_sales', 'demo_required', 'annual_commitment', 'setup_fee'];
const STEPS = ['contact_sales', 'demo_required'];
const SELF = ['free_trial', 'free_plan', 'no_credit_card', 'self_serve_signup'];
const mostCommon = (values) => {
  const counts = {};
  for (const v of values) counts[v] = (counts[v] || 0) + 1;
  return Object.keys(counts).sort((a, b) => counts[b] - counts[a] || (a < b ? -1 : 1))[0] ?? null;
};

// Price levels compare like with like: subscription prices with a stated period, same currency, same billing unit.
const recurring = input.prices.filter((p) => p.amount > 0 && p.period !== null);
const currency = mostCommon(recurring.map((p) => p.currency));
const unitKey = mostCommon(recurring.filter((p) => p.currency === currency).map((p) => p.unit ?? 'flat'));
const monthly = recurring
  .filter((p) => p.currency === currency && (p.unit ?? 'flat') === unitKey)
  .map((p) => ({ value: p.period === 'year' ? p.amount / 12 : p.amount, id: p.evidenceId, name: p.product || p.item || 'unnamed' }))
  .sort((a, b) => a.value - b.value);
const products = [...new Set(monthly.map((m) => m.name))];
const ids = (list) => [...new Set(list.map((x) => x.id || x.evidenceId))];
const median = (vals) => (vals.length % 2 ? vals[(vals.length - 1) / 2] : (vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2);
const sales = input.friction.filter((f) => f.contextual && SALES.includes(f.signal));
const ctaOnly = input.friction.filter((f) => !f.contextual && STEPS.includes(f.signal));
const self = input.friction.filter((f) => SELF.includes(f.signal));
const fees = [...input.percentFees].sort((a, b) => a.percent - b.percent);
const gated = input.friction.filter((f) => f.contextual && STEPS.includes(f.signal)).length + input.customPricingEvidence.length;
const published = input.prices.length;
const levelUnit = currency ? currency + (unitKey && unitKey !== 'flat' ? ' per ' + unitKey : '') + ' / month' : 'currency / month';
const levelNote = 'Recurring prices with a stated billing period, ' + (currency || '—') + ', unit "' + (unitKey || '—') + '"; yearly prices divided by 12. ' +
  (products.length > 1 ? 'Spans ' + products.length + ' different products (' + products.slice(0, 5).join(', ') + (products.length > 5 ? ', …' : '') + '), so it is a range, not a like-for-like plan comparison' : 'Single product: ' + (products[0] || '—'));
const noLevels = 'No recurring price with a stated billing period';
const noPricing = 'No pricing page was retrieved';
const noPages = 'No page was retrieved';
const observedCount = (list) => (input.pagesRetrieved ? list.length : null);

const metrics = [
  metric('M1', 'Published prices linked to a product or rate', 'observed', input.pricingPageRetrieved ? published : null, 'count', 'count(linked price observations)', ids(input.prices),
    input.pricingPageRetrieved ? 'Isolated amounts that could not be tied to a product or rate were discarded' : noPricing),
  metric('M2', 'Lowest recurring price', 'calculated', monthly.length ? monthly[0].value : null, levelUnit, 'min(monthly-normalised price)', ids(monthly), monthly.length ? levelNote : noLevels),
  metric('M3', 'Highest recurring price', 'calculated', monthly.length ? monthly[monthly.length - 1].value : null, levelUnit, 'max(monthly-normalised price)', ids(monthly), monthly.length ? levelNote : noLevels),
  metric('M4', 'Median recurring price', 'calculated', monthly.length ? median(monthly.map((m) => m.value)) : null, levelUnit, 'median(monthly-normalised price)', ids(monthly), monthly.length ? levelNote : noLevels),
  metric('M5', 'Recurring price spread (highest / lowest)', 'calculated', monthly.length >= 2 ? monthly[monthly.length - 1].value / monthly[0].value : null, 'x', 'M3 / M2', ids(monthly),
    monthly.length >= 2 ? levelNote : 'Needs at least two comparable recurring prices'),
  metric('M6', 'Lowest percentage fee', 'observed', fees.length ? fees[0].percent : null, '%', 'min(percentage fees)', ids(fees),
    fees.length ? [fees[0].product, fees[0].unit ? 'per ' + fees[0].unit : null, fees[0].fixedAmount !== null ? '+ ' + fees[0].fixedAmount + ' ' + fees[0].fixedCurrency : null].filter(Boolean).join(' · ') || 'No product or unit stated' : 'No percentage-based fee found'),
  metric('M7', 'Self-serve pricing share', 'calculated', published + gated > 0 ? (published / (published + gated)) * 100 : null, '%', 'M1 / (M1 + plan-linked sales steps + custom-pricing mentions) × 100',
    [...ids(input.prices), ...input.customPricingEvidence], published + gated > 0 ? 'Generic "Contact sales" buttons are not counted' : 'No pricing signals found'),
  metric('M8', 'Contextual sales-assisted signals', 'observed', observedCount(sales), 'count', 'count(plan-linked contact sales / demo, commitments, setup fees)', ids(sales),
    input.pagesRetrieved ? 'Only phrases tied to a plan, price or product; not proof of friction on its own' : noPages),
  metric('M9', 'Self-serve entry signals', 'observed', observedCount(self), 'count', 'count(free trial, free plan, no credit card, sign up)', ids(self),
    input.pagesRetrieved ? 'Phrases observed on retrieved pages' : noPages),
  metric('M10', 'Feature statements extracted', 'observed', observedCount(input.featureEvidence), 'count', 'count(feature evidence)', input.featureEvidence,
    input.pagesRetrieved ? 'Headings and list items from home/product pages' : noPages),
  metric('M11', 'Generic sales CTAs (excluded from friction)', 'observed', observedCount(ctaOnly), 'count', 'count(header/button "Contact sales", "Request a demo")', ids(ctaOnly),
    input.pagesRetrieved ? 'Call-to-action buttons without plan or price context' : noPages),
];
console.log(JSON.stringify(metrics));
`;

export function buildSandboxCode(input: SandboxInput): string {
  return `// NexusAgent computational sandbox — reproducible metrics over data extracted from retrieved pages
const input = ${JSON.stringify(input, null, 2)};
${METRICS_JS}`;
}

export function executeSandbox(research: ResearchResult): SandboxResult & { input: SandboxInput } {
  const { input, rejected } = buildSandboxInput(research);
  const code = buildSandboxCode(input);
  const lines: string[] = [];
  const started = performance.now();
  vm.runInNewContext(code, { console: { log: (...args: unknown[]) => lines.push(args.map(String).join(' ')) } }, { timeout: 1000, filename: 'nexus-sandbox.js' });
  const durationMs = Math.round((performance.now() - started) * 100) / 100;
  const metrics = JSON.parse(lines[lines.length - 1] ?? '[]') as MetricResult[];
  return { language: 'javascript', code, stdout: lines.join('\n'), metrics, rejectedInputs: rejected, durationMs, input };
}

function mostCommon(values: string[]): string | null {
  const counts = new Map<string, number>();
  values.forEach((v) => counts.set(v, (counts.get(v) ?? 0) + 1));
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? null;
}

/**
 * Independent TypeScript re-implementation of the headline calculations. The Critic compares the sandbox output
 * against it to verify that the arithmetic is correct.
 */
export function referenceMetrics(input: SandboxInput): Map<string, number | null> {
  const r = (n: number) => Math.round(n * 100) / 100;
  const recurring = input.prices.filter((p) => p.amount > 0 && p.period !== null);
  const currency = mostCommon(recurring.map((p) => p.currency));
  const unitKey = mostCommon(recurring.filter((p) => p.currency === currency).map((p) => p.unit ?? 'flat'));
  const monthly = recurring
    .filter((p) => p.currency === currency && (p.unit ?? 'flat') === unitKey)
    .map((p) => (p.period === 'year' ? p.amount / 12 : p.amount))
    .sort((a, b) => a - b);
  const mid = Math.floor(monthly.length / 2);
  const median = monthly.length === 0 ? null : monthly.length % 2 ? monthly[mid] : (monthly[mid - 1] + monthly[mid]) / 2;
  const contextual = input.friction.filter((f) => f.contextual);
  const sales = contextual.filter((f) => SALES_ASSISTED.includes(f.signal));
  const ctaOnly = input.friction.filter((f) => !f.contextual && SALES_STEPS.includes(f.signal));
  const self = input.friction.filter((f) => SELF_SERVE.includes(f.signal));
  const gated = contextual.filter((f) => SALES_STEPS.includes(f.signal)).length + input.customPricingEvidence.length;
  const published = input.prices.length;
  const minFee = input.percentFees.length ? Math.min(...input.percentFees.map((f) => f.percent)) : null;
  const pages = (n: number) => (input.pagesRetrieved ? n : null);

  return new Map<string, number | null>([
    ['M1', input.pricingPageRetrieved ? published : null],
    ['M2', monthly.length ? r(monthly[0]) : null],
    ['M3', monthly.length ? r(monthly[monthly.length - 1]) : null],
    ['M4', median === null ? null : r(median)],
    ['M5', monthly.length >= 2 ? r(monthly[monthly.length - 1] / monthly[0]) : null],
    ['M6', minFee === null ? null : r(minFee)],
    ['M7', published + gated > 0 ? r((published / (published + gated)) * 100) : null],
    ['M8', pages(sales.length)],
    ['M9', pages(self.length)],
    ['M10', pages(input.featureEvidence.length)],
    ['M11', pages(ctaOnly.length)],
  ]);
}
