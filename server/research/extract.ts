import { HTMLElement, parse } from 'node-html-parser';
import type { Evidence, EvidenceKind, FrictionSignal, PageKind, PercentFee, PriceObservation } from '../../src/types/agent.ts';

export interface PageLink {
  href: string;
  text: string;
}

/** The smallest block around one price, plus the heading it is published under. */
export interface PriceCard {
  lines: string[];
  /** Verbatim snippet for the card (guaranteed to be a substring of the page corpus). */
  snippet: string;
  heading: string | null;
}

export interface ExtractedPage {
  title: string;
  description: string;
  siteName: string;
  h1: string[];
  headings: string[];
  lines: string[];
  listItems: string[];
  links: PageLink[];
  priceCards: PriceCard[];
  /** Whitespace-normalised page text (plus title/meta), used to verify that snippets were really retrieved. */
  corpus: string;
  textChars: number;
}

export function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

const MAX_SNIPPET = 280;

function truncate(text: string): string {
  return text.length <= MAX_SNIPPET ? text : text.slice(0, MAX_SNIPPET).trim();
}

// "US$" must not be the tail of a word: in "Plus$10" the currency is "$", not "US$".
const PRICE_SOURCE = String.raw`((?<![A-Za-z])US\$|\$|€|£)\s?(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)(?:\s?(?:USD|EUR|GBP))?`;
const FEE_SOURCE = String.raw`(\d{1,2}(?:\.\d{1,2})?)\s?%(?:\s?\+\s?(?:((?<![A-Za-z])US\$|\$|€|£)\s?(\d+(?:\.\d{1,2})?)|(\d{1,3})\s?(?:¢|c\b)))?`;
const PRICE_RE = new RegExp(PRICE_SOURCE, 'gi');
const FEE_RE = new RegExp(FEE_SOURCE, 'gi');
// Non-global copies for stateless .test() checks (global regexes carry lastIndex between calls).
const HAS_PRICE = new RegExp(PRICE_SOURCE, 'i');
const HAS_FEE = new RegExp(`${FEE_SOURCE}\\s*(?:per|for|on|of)\\b`, 'i');
const HAS_FEE_PLUS = /\d\s?%\s?\+\s?(?:[$€£]|\d)/;

function countPriceTokens(text: string): number {
  return (text.match(PRICE_RE) ?? []).length + (text.match(/\d\s?%/g) ?? []).length;
}

function hasPriceToken(text: string): boolean {
  return HAS_PRICE.test(text) || HAS_FEE.test(text) || HAS_FEE_PLUS.test(text);
}

const GENERIC_HEADING = /\b(?:pricing|plans?|prices|faq|frequently asked questions|compare|navigate to)\b|^(?:more|features|resources|overview|products?|solutions)$/i;

function headingContext(text: string): string | null {
  const t = collapse(text);
  if (!t || t.length > 80 || GENERIC_HEADING.test(t) || hasPriceToken(t)) return null;
  // Taglines ("One tool to run your company."), lead-ins ("Features available:"), numbered steps ("2. Configure
  // compute") and stat counters ("5+", "130") are not product names.
  if (/[.!?:]$/.test(t) || t.split(' ').length > 6 || /^\d+[.)]\s/.test(t) || !/[a-z]/i.test(t)) return null;
  return t;
}

const HEADING_SELECTOR = 'h1,h2,h3,h4,h5,h6';

function isHeading(el: HTMLElement): boolean {
  return /^h[1-6]$/i.test(el.rawTagName);
}

/**
 * Names the product a price card belongs to from the document structure, not from document order: only headings
 * inside the card (before the price) or in a header region of an enclosing container count. Headings of sibling
 * cards that carry their own prices are never inherited. Returns up to two levels ("Billing › Pay monthly"), or null
 * when no enclosing heading exists — the product is then unknown rather than guessed.
 */
function productPath(card: HTMLElement, priceEl: HTMLElement, body: HTMLElement, order: Map<HTMLElement, number>): string | null {
  const path: string[] = [];
  const push = (h: HTMLElement | undefined) => {
    const t = h ? headingContext(h.text) : null;
    if (t && path[path.length - 1] !== t) path.push(t);
  };
  const priceOrder = order.get(priceEl) ?? 0;
  // Headings inside the card before its (single) price, innermost first, e.g. <div><h3>Plus</h3><p>$10/month</p></div>.
  const inside = card.querySelectorAll(HEADING_SELECTOR).filter((h) => (order.get(h) ?? 0) < priceOrder);
  for (let i = inside.length - 1; i >= 0 && path.length < 2; i--) push(inside[i]);

  let branch: HTMLElement = card;
  let parent = card.parentNode;
  while (parent && path.length < 2) {
    const siblings = parent.childNodes.filter((c): c is HTMLElement => c instanceof HTMLElement);
    const index = siblings.indexOf(branch);
    // Closest preceding header region: a sibling that holds a heading but no price of its own.
    for (let i = index - 1; i >= 0; i--) {
      const sib = siblings[i];
      const heading = isHeading(sib) ? sib : sib.querySelector(HEADING_SELECTOR);
      if (!heading || hasPriceToken(sib.text)) continue;
      push(heading);
      break;
    }
    if (parent === body) break;
    branch = parent;
    parent = parent.parentNode;
  }
  if (path.length === 0) return null;
  return (path.length > 1 ? `${path[1]} › ${path[0]}` : path[0]).slice(0, 100);
}

/**
 * Raw-text and inert blocks are cut out before parsing, as a browser's tokenizer would end them at their closing tag.
 * This matters: node-html-parser stops building the tree at some of them — e.g. Declarative Shadow DOM
 * (<template shadowrootmode="open"><style>…</style></template>) — silently dropping the rest of the page.
 */
const RAW_BLOCKS = /<(script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

export function stripRawBlocks(html: string): string {
  return html.replace(RAW_BLOCKS, ' ');
}

/**
 * Parses HTML into plain text structures. Scripts, styles and embedded content are discarded and never executed;
 * node-html-parser only tokenises markup.
 */
export function extractPage(html: string, baseUrl: string): ExtractedPage {
  const root = parse(stripRawBlocks(html), { comment: false, blockTextElements: { script: false, style: false, noscript: false, pre: true } });

  const meta = (selector: string) => collapse(root.querySelector(selector)?.getAttribute('content') ?? '');
  const title = collapse(root.querySelector('title')?.text ?? '');
  const description = meta('meta[name="description"]') || meta('meta[property="og:description"]');
  const siteName = meta('meta[property="og:site_name"]');

  // Links are collected before navigation chrome is stripped, so nav menus still drive page discovery.
  const links: PageLink[] = [];
  const seen = new Set<string>();
  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') ?? '';
    if (!href || href.startsWith('#') || /^(mailto|tel|javascript|data):/i.test(href)) continue;
    let absolute: string;
    try {
      const u = new URL(href, baseUrl);
      u.hash = '';
      absolute = u.toString();
    } catch {
      continue;
    }
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    links.push({ href: absolute, text: collapse(a.text).slice(0, 80) });
    if (links.length >= 400) break;
  }

  for (const node of root.querySelectorAll('script,style,noscript,template,svg,iframe,object,embed,nav,footer,[role="navigation"],[aria-hidden="true"]')) {
    node.remove();
  }
  const body = root.querySelector('body') ?? root;

  const lines = body.structuredText
    .split('\n')
    .map(collapse)
    .filter((l) => l.length >= 2)
    .slice(0, 4000);
  const bodyText = collapse(body.text);
  const corpus = collapse([title, description, siteName, bodyText, lines.join(' ')].join(' \n ')).slice(0, 800_000);

  /** Prefer the readable block-separated text; fall back to raw text when only that is in the corpus. */
  const verbatim = (el: HTMLElement): string => {
    const structured = collapse(el.structuredText.split('\n').map(collapse).filter(Boolean).join(' '));
    const raw = collapse(el.text);
    for (const candidate of [structured, raw]) {
      const t = truncate(candidate);
      if (t && corpus.includes(t)) return t;
    }
    return truncate(raw);
  };

  const h1 = body.querySelectorAll('h1').map(verbatim).filter((t) => t.length > 0 && t.length <= 200);
  const headings = body
    .querySelectorAll('h2,h3')
    .map(verbatim)
    .filter((t) => t.length >= 3 && t.length <= 160);
  const listItems = body
    .querySelectorAll('li')
    .map(verbatim)
    .filter((t) => t.length >= 12 && t.length <= 180);

  // Price cards: the innermost element holding a price, widened to its card, labelled by its structural headings.
  const priceCards: PriceCard[] = [];
  const usedCards = new Set<HTMLElement>();
  const elements = body.querySelectorAll('*');
  const order = new Map(elements.map((e, i) => [e, i]));
  for (const el of elements) {
    const text = el.text;
    if (text.length > 2_000 || !hasPriceToken(text)) continue;
    // Only the innermost element containing the price token.
    if (el.childNodes.some((c) => c instanceof HTMLElement && hasPriceToken(c.text))) continue;
    let card: HTMLElement = el;
    const tokens = countPriceTokens(text);
    while (card.parentNode && card.parentNode !== body && collapse(card.parentNode.text).length <= 320 && countPriceTokens(card.parentNode.text) === tokens) {
      card = card.parentNode;
    }
    if (usedCards.has(card)) continue;
    usedCards.add(card);
    const cardLines = card.structuredText.split('\n').map(collapse).filter(Boolean);
    if (collapse(card.text).length > 320) continue; // a price inside long marketing copy is not a tariff
    priceCards.push({ lines: cardLines, snippet: verbatim(card), heading: productPath(card, el, body, order) });
    if (priceCards.length >= 150) break; // large tariff pages (e.g. Stripe) list 100+ prices
  }

  return { title, description, siteName, h1, headings, lines, listItems, links, priceCards, corpus, textChars: bodyText.length };
}

// ---------------------------------------------------------------------------
// Low-content diagnosis and embedded structured data
// ---------------------------------------------------------------------------

export type LowContentReason = 'blocked' | 'error_page' | 'client_rendered' | 'empty';

const BLOCKED_RE = /captcha|are you a robot|access denied|attention required|just a moment|enable javascript and cookies|request blocked|unusual traffic|bot protection/i;
const ERROR_RE = /\b(?:404|403|410|500|not found|page not found|error)\b/i;
const APP_SHELL_RE = /<div[^>]+id=["'](?:root|app|__next|__nuxt|svelte|main-app)["'][^>]*>\s*<\/div>/i;

/** Explains why a page yielded too little text, without assuming it is a single-page app. */
export function diagnoseLowContent(html: string, page: ExtractedPage): { reason: LowContentReason; message: string } {
  const visible = `${page.title} ${page.lines.join(' ')}`;
  if (BLOCKED_RE.test(visible)) return { reason: 'blocked', message: 'The site served a bot check or access-denied page instead of content' };
  if (ERROR_RE.test(page.title) || (page.h1[0] && ERROR_RE.test(page.h1[0]))) return { reason: 'error_page', message: `The site returned an error page ("${page.title || page.h1[0]}")` };
  const scripts = (html.match(/<script\b/gi) ?? []).length;
  if (APP_SHELL_RE.test(html) || (scripts >= 3 && page.textChars < 120)) {
    return { reason: 'client_rendered', message: 'The page appears to build its content with JavaScript, which NexusAgent never executes' };
  }
  return { reason: 'empty', message: 'The response contained almost no readable text' };
}

const JSON_SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const HUMAN_TEXT_RE = /[A-Za-z]{2,}[^A-Za-z]+[A-Za-z]{2,}|[$€£]\s?\d/;
const NOT_PROSE_RE = /^(?:https?:|\/|#|data:|[\w-]+\.(?:js|css|png|jpg|svg|webp)$)|[{};<>]|^[A-Za-z0-9+/=_-]{24,}$/;

/**
 * Collects human-readable strings from structured data embedded in the page (JSON-LD, Next/Nuxt payloads,
 * application/json blocks). The JSON is only parsed with JSON.parse — nothing is ever evaluated.
 */
export function extractEmbeddedText(html: string, limit = 400): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (value: unknown, depth: number) => {
    if (out.length >= limit || depth > 40) return;
    if (typeof value === 'string') {
      const t = collapse(value);
      if (t.length >= 3 && t.length <= 300 && HUMAN_TEXT_RE.test(t) && !NOT_PROSE_RE.test(t) && !seen.has(t)) {
        seen.add(t);
        out.push(t);
      }
    } else if (Array.isArray(value)) value.forEach((v) => walk(v, depth + 1));
    else if (value && typeof value === 'object') Object.values(value).forEach((v) => walk(v, depth + 1));
  };
  for (const m of html.matchAll(JSON_SCRIPT_RE)) {
    const attrs = m[1];
    if (!/type=["']application\/(?:ld\+)?json["']|id=["']__(?:NEXT|NUXT)_DATA__["']/i.test(attrs)) continue;
    if (m[2].length > 2_000_000) continue;
    try {
      walk(JSON.parse(m[2]), 0);
    } catch {
      // Malformed embedded JSON is simply ignored.
    }
  }
  return out;
}

/** Wraps embedded strings as a minimal HTML page so they go through the same extraction and verification path. */
export function embeddedTextPage(strings: string[], baseUrl: string): ExtractedPage {
  const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return extractPage(`<body>${strings.map((s) => `<p>${escape(s)}</p>`).join('')}</body>`, baseUrl);
}

// ---------------------------------------------------------------------------
// Price parsing
// ---------------------------------------------------------------------------

const CURRENCY: Record<string, PriceObservation['currency']> = { $: 'USD', 'US$': 'USD', '€': 'EUR', '£': 'GBP' };
const LEADING_QUALIFIER = /^(starting at|starts at|from|only|just|as low as|up to)$/i;
const PERIOD_WORD: Record<string, 'month' | 'year'> = { month: 'month', mo: 'month', monthly: 'month', year: 'year', yr: 'year', annum: 'year', annually: 'year' };
const TERMS_RE = /\b(\d+-(?:year|month) (?:contract|commitment|term)|(?:billed|paid) (?:annually|monthly|yearly)|annual (?:contract|commitment|billing)|minimum (?:of )?[^.,;]{1,30}|starting at|starts at|as low as)\b/gi;

interface RateContext {
  item: string | null;
  unit: string | null;
  period: 'month' | 'year' | null;
}

/** Reads the line item before a price and the unit/period stated right after it. Missing fields stay null. */
/** The line item named immediately before a price, e.g. "Dispute received fee $15.00". Null when there is none. */
function lineItem(prefix: string): string | null {
  let t = collapse(prefix.split(/[.!?]\s+/).pop() ?? '');
  t = t.replace(/\b(?:starting at|starts at|from|then|at|for|only|just|as low as|up to)\s*$/i, '').trim().replace(/[:–—-]\s*$/, '').trim();
  if (!t || t.length > 60 || LEADING_QUALIFIER.test(t) || hasPriceToken(t) || !/[a-z]/i.test(t)) return null;
  // Lower-case connectors ("then $0.12", "plus $5") are not line items; capitalised plan names ("Plus") are.
  if (/^(?:then|plus|and|or|additional|extra|each|per|includes?|with)$/.test(t)) return null;
  return t;
}

function rateContext(card: PriceCard, matchLine: string, tokenStart: number, tokenEnd: number, singlePrice: boolean): RateContext {
  const item = lineItem(matchLine.slice(0, tokenStart));

  // The rate is read from the rest of the same line; only when the price ends its line is the next line used.
  const lineIndex = card.lines.indexOf(matchLine);
  const rest = collapse(matchLine.slice(tokenEnd));
  const after = rest || (lineIndex >= 0 ? (card.lines[lineIndex + 1] ?? '') : '');
  const unitMatch =
    /^(?:\/\s*|per\s*|for each\s+|each\s+|a\s+)((?:[a-z0-9 /&'-]|,(?=\d{3}))*?[a-z0-9])(?=\s*(?:,(?!\d{3})|[.;()]|$)|\s+(?:billed|paid|with|plus|and|or|after|when)\b)/i.exec(after);
  let unit: string | null = null;
  let period: 'month' | 'year' | null = null;
  if (unitMatch && unitMatch[1].length <= 70) {
    for (const part of unitMatch[1].split(/\s*(?:\/|\bper\b)\s*/i).map((p) => p.trim()).filter(Boolean)) {
      // Prefix match tolerates text glued by markup, e.g. "seat/monthSign up".
      const word = /^(month|year|annum)|^(mo|yr)\b/i.exec(part)?.[0].toLowerCase();
      const p = word ? PERIOD_WORD[word] : undefined;
      if (p && !period) {
        period = p;
        // A stated scope after the period is the billing unit: "$75 per month for first project" → "first project".
        const scope = /^\s*(?:for|each)\s+(?:the\s+|each\s+)?([a-z][a-z0-9 ,'-]{1,40})$/i.exec(part.slice(word?.length ?? 0));
        if (scope && !unit) unit = scope[1].trim();
      } else if (!p && !unit) unit = part;
    }
  }
  if (!period && singlePrice) {
    const joined = card.lines.join(' ');
    if (/\b(?:per month|\/\s?mo\b|monthly)\b/i.test(joined)) period = 'month';
    else if (/\b(?:per year|\/\s?yr\b|yearly|per annum)\b/i.test(joined)) period = 'year';
  }
  return { item, unit, period };
}

export interface ParsedCard {
  prices: PriceObservation[];
  percentFees: PercentFee[];
  discarded: number;
}

/**
 * Parses the prices of one card. A price is kept only if it can be tied to a product heading, a named line item,
 * or a stated unit/period; isolated amounts are counted as discarded.
 */
export function parsePriceCard(card: PriceCard, evidenceId: string): ParsedCard {
  const prices: PriceObservation[] = [];
  const percentFees: PercentFee[] = [];
  let discarded = 0;
  const product = card.heading;
  const terms = [...new Set([...card.lines.join(' ').matchAll(TERMS_RE)].map((m) => collapse(m[1]).replace(/^\w/, (c) => c.toUpperCase())))].slice(0, 4);
  const single = countPriceTokens(card.lines.join(' ')) === 1;

  for (const line of card.lines) {
    const feeSpans: [number, number][] = [];
    for (const m of line.matchAll(FEE_RE)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      const hasFixed = m[3] !== undefined || m[4] !== undefined;
      const ctx = rateContext(card, line, start, end, single);
      // A bare percentage is only a fee when a rate unit follows ("2.9% per transaction") or a fixed part is attached.
      if (!hasFixed && !ctx.unit) continue;
      feeSpans.push([start, end]);
      if (!product && !ctx.item && !ctx.unit) {
        discarded += 1;
        continue;
      }
      percentFees.push({
        evidenceId,
        percent: Number(m[1]),
        fixedAmount: m[3] !== undefined ? Number(m[3]) : m[4] !== undefined ? Number(m[4]) / 100 : null,
        fixedCurrency: m[2] ? (CURRENCY[m[2]] ?? 'USD') : m[4] !== undefined ? 'USD' : null,
        product,
        item: ctx.item,
        unit: ctx.unit,
      });
    }
    for (const m of line.matchAll(PRICE_RE)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (feeSpans.some(([s, e]) => start >= s && start < e)) continue; // fixed part of a percentage fee
      const amount = Number(m[2].replace(/,/g, ''));
      if (!Number.isFinite(amount)) continue;
      const ctx = rateContext(card, line, start, end, single);
      if (!product && !ctx.item && !ctx.unit && !ctx.period) {
        discarded += 1;
        continue;
      }
      prices.push({ evidenceId, amount, currency: CURRENCY[m[1]] ?? 'USD', product, item: ctx.item, unit: ctx.unit, period: ctx.period, terms });
    }
  }
  return { prices: prices.slice(0, 6), percentFees: percentFees.slice(0, 6), discarded };
}

// ---------------------------------------------------------------------------
// Evidence classification
// ---------------------------------------------------------------------------

const AUDIENCE_RE =
  /\b(?:for|built for|designed for|made for|trusted by|used by|loved by|helps?)\b[^.]{0,80}\b(?:teams|businesses|companies|developers|startups|enterprises?|platforms|marketplaces|creators|agencies|engineers|founders|organi[sz]ations|SMBs?|retailers|merchants|designers|marketers)\b/i;

const FRICTION_PATTERNS: [FrictionSignal, RegExp][] = [
  ['contact_sales', /\b(?:contact|talk to|speak (?:with|to)|chat with) (?:our )?sales\b|\bcontact us for pricing\b/i],
  ['demo_required', /\b(?:request|book|schedule|get) a (?:demo|call)\b/i],
  ['free_trial', /\bfree trial\b|\btry (?:it )?free for \d+ days\b|\bstart (?:a|your) (?:free )?trial\b/i],
  ['free_plan', /\bfree (?:plan|tier|forever)\b|\bfree for (?:individuals|small teams|up to)\b|\bfree to (?:start|get started)\b/i],
  ['no_credit_card', /\bno credit card(?: required| needed)?\b/i],
  ['self_serve_signup', /\b(?:sign up|get started|start now|create (?:an |your )?account)\b/i],
  ['annual_commitment', /\bbilled annually\b|\bannual (?:contract|commitment)\b|\b\d+-year contract\b/i],
  ['setup_fee', /\bsetup fees?\b|\bimplementation fees?\b|\bonboarding fees?\b/i],
  ['usage_limits', /\bup to \d[\d,.]*\s?(?:users|seats|members|projects|requests|events|GB|MB)\b|\blimit(?:ed)? to \d/i],
];

/** Signals that describe a cost or obstacle; these are skipped when negated ("No setup fees"). */
const NEGATABLE: FrictionSignal[] = ['setup_fee', 'annual_commitment', 'usage_limits', 'contact_sales', 'demo_required'];
const NEGATION_BEFORE = /\b(?:no|without|zero|never|free of|don't need to|do not need to|not required to)\b[^.]{0,25}$/i;
const SALES_SIGNALS: FrictionSignal[] = ['contact_sales', 'demo_required'];
const PRICING_CONTEXT = /\b(?:pricing|price|plan|tier|enterprise|quote|volume|custom|contract|discount|billing|seats?)\b/i;
const CTA_ONLY = /^(?:(?:start now|contact sales|talk to sales|get started|sign up|sign in|log in|create account|request a demo|book a demo|get a demo|start (?:your )?free trial|try (?:it )?(?:for )?free|learn more|ready to get started\??|or)\s*)+$/i;

/** True for generic call-to-action button text that is not tied to any plan or price. */
export function isGenericCta(line: string): boolean {
  return CTA_ONLY.test(line.trim()) || line.split(' ').length <= 3;
}

function matchSignal(line: string, signal: FrictionSignal, re: RegExp): boolean {
  const m = re.exec(line);
  if (!m) return false;
  if (NEGATABLE.includes(signal) && NEGATION_BEFORE.test(line.slice(0, m.index))) return false;
  return true;
}

const CUSTOM_PRICING_RE = /\bcustom (?:pricing|plans?|quotes?)\b|\bcontact (?:sales|us) for (?:pricing|a quote)\b|\btailored pricing\b|\brequest a quote\b|\bvolume discounts?\b/i;
const GENERIC_FEATURE = /^(?:pricing|resources|company|product|products|solutions|features|developers|support|blog|about|contact|legal|faq|frequently asked questions|sign in|log in)$/i;

export interface ClassifiedEvidence {
  evidence: Evidence[];
  prices: PriceObservation[];
  percentFees: PercentFee[];
  discardedPriceFragments: number;
}

/** Turns an extracted page into verbatim evidence items. Every snippet is a substring of the page corpus. */
export function classifyEvidence(page: ExtractedPage, source: { id: string; url: string; kind: PageKind }, nextId: () => string): ClassifiedEvidence {
  const evidence: Evidence[] = [];
  const prices: PriceObservation[] = [];
  const percentFees: PercentFee[] = [];
  let discardedPriceFragments = 0;
  const used = new Set<string>();
  const add = (kind: EvidenceKind, text: string, extra: Partial<Evidence> = {}): Evidence | null => {
    const snippet = truncate(collapse(text));
    const key = `${kind}:${extra.signal ?? ''}:${snippet}`;
    if (snippet.length < 8 || used.has(key)) return null;
    used.add(key);
    const item: Evidence = { id: nextId(), sourceId: source.id, url: source.url, kind, snippet, ...extra };
    evidence.push(item);
    return item;
  };

  if (source.kind === 'home' || source.kind === 'product') {
    for (const h of page.h1.slice(0, 1)) add('value_prop', h);
    if (page.description) add('value_prop', page.description);
    const featureCandidates = [...page.headings, ...page.listItems].filter((t) => t.split(' ').length >= 3 && !GENERIC_FEATURE.test(t) && !hasPriceToken(t));
    for (const f of featureCandidates.slice(0, source.kind === 'product' ? 10 : 6)) add('feature', f);
  }

  let audience = 0;
  for (const line of page.lines) {
    if (audience >= 3) break;
    if (line.length <= 240 && AUDIENCE_RE.test(line) && add('audience', line)) audience += 1;
  }

  if (source.kind === 'pricing') {
    for (const card of page.priceCards.slice(0, 120)) {
      const probe = parsePriceCard(card, 'probe');
      discardedPriceFragments += probe.discarded;
      if (probe.prices.length === 0 && probe.percentFees.length === 0) continue;
      const item = add('pricing', card.snippet, card.heading ? { context: card.heading } : {});
      if (!item) continue;
      prices.push(...probe.prices.map((p) => ({ ...p, evidenceId: item.id })));
      percentFees.push(...probe.percentFees.map((f) => ({ ...f, evidenceId: item.id })));
    }
    let custom = 0;
    for (const line of page.lines) {
      if (custom >= 3) break;
      if (line.length <= 240 && CUSTOM_PRICING_RE.test(line) && add('custom_pricing', line)) custom += 1;
    }
  }

  for (const [signal, re] of FRICTION_PATTERNS) {
    const candidates = page.lines.filter((l) => l.length <= 240 && matchSignal(l, signal, re));
    if (candidates.length === 0) continue;
    if (SALES_SIGNALS.includes(signal)) {
      // A sales step only counts as friction when it is tied to a plan or price, not a generic header button.
      const contextual = candidates.find((l) => !isGenericCta(l) && PRICING_CONTEXT.test(l));
      if (contextual) add('friction', contextual, { signal, contextual: true });
      else add('friction', candidates[0], { signal, contextual: false });
    } else {
      const line = candidates.find((l) => !isGenericCta(l)) ?? candidates[0];
      add('friction', line, { signal, contextual: !isGenericCta(line) });
    }
  }

  if (source.kind === 'docs') {
    add('docs', page.title || page.h1[0] || '');
    if (page.description) add('docs', page.description);
  }

  return { evidence, prices, percentFees, discardedPriceFragments };
}
