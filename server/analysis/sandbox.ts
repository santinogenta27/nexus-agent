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
// Price levels (M2–M5) compare like with like only. A comparable group shares: currency, the billing unit exactly as
// stated (never inferred; "not stated" only matches "not stated"), the product family, and the price role (base plan
// price vs. named line item). Add-ons are never compared. Yearly prices are normalised to months.
const ADDON = /add-?on|additional|extra|overage|top-?up/i;
const roleOf = (p) => (ADDON.test((p.item || '') + ' ' + (p.unit || '')) ? 'addon' : p.item ? 'line item' : 'plan');
const familyOf = (p) => (p.product === null ? 'unknown product' : p.product.includes(' › ') ? p.product.split(' › ')[0] : 'top-level plans');
const unitOf = (p) => (p.unit === null ? 'unit not stated' : p.unit.toLowerCase());
const nameOf = (p) => p.product || p.item || 'unnamed';
const recurring = input.prices.filter((p) => p.amount > 0 && p.period !== null);
const addons = recurring.filter((p) => roleOf(p) === 'addon');
const groups = {};
for (const p of recurring) {
  if (roleOf(p) === 'addon') continue;
  const key = [p.currency, unitOf(p), familyOf(p), roleOf(p)].join(' | ');
  (groups[key] = groups[key] || []).push(p);
}
// Largest group wins; ties go to the group with more distinct products, then to the one appearing first on the page.
const ranked = Object.entries(groups).sort(
  (a, b) => b[1].length - a[1].length || new Set(b[1].map(nameOf)).size - new Set(a[1].map(nameOf)).size || input.prices.indexOf(a[1][0]) - input.prices.indexOf(b[1][0]),
);
const chosen = ranked.length ? ranked[0][1] : [];
const chosenKey = ranked.length ? ranked[0][0].split(' | ') : null;
const currency = chosenKey ? chosenKey[0] : null;
const monthly = chosen
  .map((p) => ({ value: p.period === 'year' ? p.amount / 12 : p.amount, id: p.evidenceId, name: nameOf(p) }))
  .sort((a, b) => a.value - b.value);
const products = [...new Set(monthly.map((m) => m.name))];
const excluded = recurring.length - chosen.length;
const ids = (list) => [...new Set(list.map((x) => x.id || x.evidenceId))];
const median = (vals) => (vals.length % 2 ? vals[(vals.length - 1) / 2] : (vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2);
const sales = input.friction.filter((f) => f.contextual && SALES.includes(f.signal));
const ctaOnly = input.friction.filter((f) => !f.contextual && STEPS.includes(f.signal));
const self = input.friction.filter((f) => SELF.includes(f.signal));
const fees = [...input.percentFees].sort((a, b) => a.percent - b.percent);
const gated = input.friction.filter((f) => f.contextual && STEPS.includes(f.signal)).length + input.customPricingEvidence.length;
const published = input.prices.length;
const levelUnit = chosenKey ? currency + (chosenKey[1] !== 'unit not stated' ? ' per ' + chosenKey[1] : '') + ' / month' : 'currency / month';
const levelNote = chosenKey
  ? 'Compared ' + chosen.length + ' recurring ' + chosenKey[3] + ' price(s) of ' + chosenKey[2] + ' (' + products.slice(0, 5).join(', ') + (products.length > 5 ? ', …' : '') + '), ' +
    currency + ', ' + chosenKey[1] + '; yearly prices divided by 12.' +
    (excluded > 0 ? ' Excluded ' + excluded + ' recurring price(s) with a different currency, unit, product family or role' + (addons.length ? ', including ' + addons.length + ' add-on(s)' : '') + '.' : '')
  : '';
const noLevels = recurring.length === 0
  ? 'No recurring price with a stated billing period'
  : 'Only add-on recurring prices were found (' + addons.length + '); there is no comparable plan price';
const noSpread = chosen.length === 1
  ? 'Only one comparable recurring price: ' + recurring.length + ' recurring price(s) fall into ' + (ranked.length + (addons.length ? 1 : 0)) + ' incompatible group(s) (currency, unit, product family, role)'
  : noLevels;
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
    monthly.length >= 2 ? levelNote : noSpread),
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

type PriceRole = 'plan' | 'line item' | 'addon';

/**
 * The comparable recurring price group used for M2–M5: same currency, same stated unit (unstated only matches
 * unstated), same product family and same role; add-ons are never compared. Exported for regression tests.
 */
export function comparableRecurringPrices(prices: PriceObservation[]): PriceObservation[] {
  const addon = /add-?on|additional|extra|overage|top-?up/i;
  const role = (p: PriceObservation): PriceRole => (addon.test(`${p.item ?? ''} ${p.unit ?? ''}`) ? 'addon' : p.item ? 'line item' : 'plan');
  const family = (p: PriceObservation) => (p.product === null ? 'unknown product' : p.product.includes(' › ') ? p.product.split(' › ')[0] : 'top-level plans');
  const name = (p: PriceObservation) => p.product || p.item || 'unnamed';
  const groups = new Map<string, PriceObservation[]>();
  for (const p of prices) {
    if (p.amount <= 0 || p.period === null || role(p) === 'addon') continue;
    const key = `${p.currency}|${p.unit === null ? '∅' : p.unit.toLowerCase()}|${family(p)}|${role(p)}`;
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  const distinct = (g: PriceObservation[]) => new Set(g.map(name)).size;
  const best = [...groups.values()].sort((a, b) => b.length - a.length || distinct(b) - distinct(a) || prices.indexOf(a[0]) - prices.indexOf(b[0]))[0];
  return best ?? [];
}

/**
 * Independent TypeScript re-implementation of the headline calculations. The Critic compares the sandbox output
 * against it to verify that the arithmetic is correct.
 */
export function referenceMetrics(input: SandboxInput): Map<string, number | null> {
  const r = (n: number) => Math.round(n * 100) / 100;
  const monthly = comparableRecurringPrices(input.prices)
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
