import type { Evidence, PageKind, PercentFee, PriceObservation, ResearchResult, ResearchStatus, ResearchTarget, SourceRecord } from '../../src/types/agent.ts';
import { DEFAULT_POLICY, FetchError, fetchPage, validateUrl } from '../net/safeFetch.ts';
import type { NetworkPolicy } from '../net/safeFetch.ts';
import { classifyEvidence, extractPage } from './extract.ts';
import type { ExtractedPage } from './extract.ts';

export interface ResearchOptions {
  policy?: NetworkPolicy;
  maxPages?: number;
  budgetMs?: number;
  perRequestTimeoutMs?: number;
  maxBytes?: number;
  concurrency?: number;
  /** Candidate domain suggested by the Supervisor; verified by fetching before it is used. */
  domainGuess?: string | null;
}

export const RESEARCH_DEFAULTS = { maxPages: 6, budgetMs: 22_000, perRequestTimeoutMs: 8_000, maxBytes: 3_000_000, concurrency: 3 } as const;

/** Pages with less visible text than this are treated as empty (e.g. client-rendered shells). */
const MIN_TEXT_CHARS = 200;

export interface ResearchOutput extends ResearchResult {
  /** sourceId → normalised page text, kept server-side for citation verification. */
  corpora: Record<string, string>;
}

interface FetchedSource {
  record: SourceRecord;
  page: ExtractedPage | null;
}

function errorText(error: unknown): { status: SourceRecord['status']; message: string; httpStatus?: number } {
  if (error instanceof FetchError) {
    return { status: error.code === 'blocked' ? 'blocked' : 'failed', message: error.message, ...(error.status ? { httpStatus: error.status } : {}) };
  }
  return { status: 'failed', message: error instanceof Error ? error.message : String(error) };
}

async function fetchSource(id: string, url: string, kind: PageKind, timeoutMs: number, opts: Required<Pick<ResearchOptions, 'policy' | 'maxBytes'>>): Promise<FetchedSource> {
  const started = Date.now();
  const base: SourceRecord = { id, url, kind, status: 'failed', bytes: 0, textChars: 0, durationMs: 0 };
  if (timeoutMs < 500) {
    return { record: { ...base, error: 'Skipped: research time budget exhausted' }, page: null };
  }
  try {
    const fetched = await fetchPage(url, { policy: opts.policy, timeoutMs, maxBytes: opts.maxBytes });
    const page = extractPage(fetched.body, fetched.finalUrl);
    const empty = page.textChars < MIN_TEXT_CHARS;
    return {
      record: {
        ...base,
        finalUrl: fetched.finalUrl,
        status: empty ? 'empty' : 'ok',
        httpStatus: fetched.status,
        title: page.title || undefined,
        bytes: fetched.bytes,
        textChars: page.textChars,
        durationMs: Date.now() - started,
        ...(empty ? { error: `Page returned only ${page.textChars} characters of visible text` } : {}),
      },
      page: empty ? null : page,
    };
  } catch (error) {
    const failure = errorText(error);
    return {
      record: { ...base, status: failure.status, durationMs: Date.now() - started, error: failure.message, ...(failure.httpStatus ? { httpStatus: failure.httpStatus } : {}) },
      page: null,
    };
  }
}

function normaliseName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Normalises user input like "stripe.com" or "https://stripe.com/" into an absolute URL. */
export function normaliseUrlInput(raw: string): string {
  const trimmed = raw.trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function registrableDomain(hostname: string): string {
  const parts = hostname.replace(/^www\./, '').split('.');
  return parts.slice(-2).join('.');
}

const CATEGORY_RULES: { kind: PageKind; path: RegExp; text: RegExp; limit: number }[] = [
  { kind: 'pricing', path: /\/(?:pricing|plans|prices?)(?:\/|$)/i, text: /^(?:pricing|plans(?: & pricing)?|prices)$/i, limit: 2 },
  { kind: 'product', path: /\/(?:products?|features|platform|solutions?)(?:\/|$)/i, text: /^(?:products?|features|platform|solutions?|overview)$/i, limit: 2 },
  { kind: 'docs', path: /\/(?:docs|documentation|developers?|api)(?:\/|$)/i, text: /^(?:docs|documentation|developers?|api reference)$/i, limit: 1 },
  { kind: 'customers', path: /\/(?:customers|case-studies|stories)(?:\/|$)/i, text: /^(?:customers|case studies|customer stories)$/i, limit: 1 },
];

const EXCLUDED_PATH = /\/(?:login|log-in|signin|sign-in|signup|sign-up|register|legal|privacy|terms|cookies?|careers|jobs|blog|press|status)(?:\/|$)/i;

/** Picks a few relevant same-site pages from the homepage's links. */
export function discoverPages(home: ExtractedPage, homeUrl: string, maxExtra: number): { url: string; kind: PageKind }[] {
  const base = new URL(homeUrl);
  const site = registrableDomain(base.hostname);
  const picked: { url: string; kind: PageKind }[] = [];
  const taken = new Set<string>([base.origin + base.pathname]);

  for (const rule of CATEGORY_RULES) {
    const matches = home.links
      .map((link) => ({ link, url: new URL(link.href) }))
      .filter(({ url }) => (url.protocol === 'https:' || url.protocol === 'http:') && (url.hostname === site || url.hostname.endsWith(`.${site}`)))
      .filter(({ url }) => !EXCLUDED_PATH.test(url.pathname))
      .filter(({ link, url }) => rule.path.test(url.pathname) || rule.text.test(link.text) || (rule.kind === 'docs' && url.hostname.startsWith('docs.')))
      .map(({ url }) => {
        url.search = '';
        return url.toString();
      })
      .filter((u) => !taken.has(u))
      .sort((a, b) => a.length - b.length);
    const unique = [...new Set(matches)].slice(0, rule.limit);
    for (const url of unique) {
      taken.add(url);
      picked.push({ url, kind: rule.kind });
    }
  }
  if (!picked.some((p) => p.kind === 'pricing')) picked.unshift({ url: new URL('/pricing', base.origin).toString(), kind: 'pricing' });

  // Keep category diversity: one page of each kind first, then the remainder.
  const ordered = [...picked.filter((p, i) => picked.findIndex((q) => q.kind === p.kind) === i), ...picked.filter((p, i) => picked.findIndex((q) => q.kind === p.kind) !== i)];
  return ordered.slice(0, maxExtra);
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function candidateDomains(company: string, guess: string | null | undefined): { url: string; method: 'llm_suggestion_verified' | 'domain_heuristic_verified' }[] {
  const slug = normaliseName(company);
  const out: { url: string; method: 'llm_suggestion_verified' | 'domain_heuristic_verified' }[] = [];
  if (guess) {
    const cleaned = guess.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
    if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(cleaned)) out.push({ url: `https://${cleaned}`, method: 'llm_suggestion_verified' });
  }
  if (slug.length >= 2) {
    for (const tld of ['com', 'io', 'ai', 'co', 'app']) {
      const url = `https://${slug}.${tld}`;
      if (!out.some((c) => c.url === url)) out.push({ url, method: 'domain_heuristic_verified' });
    }
  }
  return out.slice(0, 5);
}

function pageNamesCompany(page: ExtractedPage, company: string): boolean {
  const needle = normaliseName(company);
  if (needle.length < 2) return false;
  return [page.title, page.siteName, page.h1[0] ?? '', page.description].some((field) => normaliseName(field).includes(needle));
}

/**
 * Researches a company's public web presence: resolves the official site, fetches a bounded set of relevant pages
 * concurrently and extracts verbatim evidence. Never reports a source as researched unless it was fetched and parsed.
 */
export async function researchCompany(input: { company?: string; url?: string }, options: ResearchOptions = {}): Promise<ResearchOutput> {
  const started = Date.now();
  const policy = options.policy ?? DEFAULT_POLICY;
  const maxPages = options.maxPages ?? RESEARCH_DEFAULTS.maxPages;
  const budgetMs = options.budgetMs ?? RESEARCH_DEFAULTS.budgetMs;
  const perRequest = options.perRequestTimeoutMs ?? RESEARCH_DEFAULTS.perRequestTimeoutMs;
  const maxBytes = options.maxBytes ?? RESEARCH_DEFAULTS.maxBytes;
  const concurrency = options.concurrency ?? RESEARCH_DEFAULTS.concurrency;
  const deadline = started + budgetMs;
  const timeLeft = () => Math.min(perRequest, deadline - Date.now());
  const fetchOpts = { policy, maxBytes };

  let counter = 0;
  const nextSourceId = () => `S${++counter}`;
  let evidenceCounter = 0;
  const nextEvidenceId = () => `E${++evidenceCounter}`;

  const sources: SourceRecord[] = [];
  const target: ResearchTarget = { company: input.company?.trim() || '', url: null, resolvedBy: 'unresolved', candidatesTried: [] };
  let home: FetchedSource | null = null;

  // 1. Resolve the primary source.
  if (input.url) {
    const url = normaliseUrlInput(input.url);
    try {
      validateUrl(url, policy);
    } catch (error) {
      const failure = errorText(error);
      sources.push({ id: nextSourceId(), url, kind: 'home', status: failure.status, bytes: 0, textChars: 0, durationMs: 0, error: failure.message });
      target.candidatesTried.push({ url, outcome: failure.message });
    }
    if (sources.length === 0) {
      home = await fetchSource(nextSourceId(), url, 'home', timeLeft(), fetchOpts);
      sources.push(home.record);
      target.candidatesTried.push({ url, outcome: home.record.status === 'ok' ? 'fetched' : (home.record.error ?? home.record.status) });
      target.url = home.record.finalUrl ?? url;
      target.resolvedBy = 'user_url';
    }
  } else if (target.company) {
    const candidates = candidateDomains(target.company, options.domainGuess);
    for (const { url, method } of candidates) {
      if (deadline - Date.now() < 2_000) break;
      const attempt = await fetchSource('candidate', url, 'home', Math.min(timeLeft(), 6_000), fetchOpts);
      if (attempt.page && pageNamesCompany(attempt.page, target.company)) {
        attempt.record.id = nextSourceId();
        home = attempt;
        sources.push(attempt.record);
        target.url = attempt.record.finalUrl ?? url;
        target.resolvedBy = method;
        target.candidatesTried.push({ url, outcome: `selected: page title/brand mentions "${target.company}"` });
        break;
      }
      target.candidatesTried.push({
        url,
        outcome: attempt.page ? `rejected: page does not mention "${target.company}"` : (attempt.record.error ?? attempt.record.status),
      });
    }
  }

  // 2. Discover and fetch secondary pages from the verified homepage.
  if (home?.page && target.url) {
    if (!target.company) target.company = home.page.siteName || home.page.title.split(/[|\-–—:]/)[0].trim() || new URL(target.url).hostname;
    const extra = discoverPages(home.page, target.url, maxPages - 1);
    const fetched = await mapLimit(extra, concurrency, (p) => fetchSource(nextSourceId(), p.url, p.kind, timeLeft(), fetchOpts));
    sources.push(...fetched.map((f) => f.record));
    const pages: FetchedSource[] = [home, ...fetched];

    const evidence: Evidence[] = [];
    const prices: PriceObservation[] = [];
    const percentFees: PercentFee[] = [];
    let discardedPriceFragments = 0;
    const corpora: Record<string, string> = {};
    for (const source of pages) {
      if (!source.page || source.record.status !== 'ok') continue;
      corpora[source.record.id] = source.page.corpus;
      const classified = classifyEvidence(source.page, { id: source.record.id, url: source.record.finalUrl ?? source.record.url, kind: source.record.kind }, nextEvidenceId);
      evidence.push(...classified.evidence);
      prices.push(...classified.prices);
      percentFees.push(...classified.percentFees);
      discardedPriceFragments += classified.discardedPriceFragments;
    }
    const { status, reason } = researchStatus(sources, evidence);
    return { target, status, statusReason: reason, sources, evidence, prices, percentFees, discardedPriceFragments, durationMs: Date.now() - started, corpora };
  }

  if (!target.company && input.url) {
    try {
      target.company = new URL(normaliseUrlInput(input.url)).hostname.replace(/^www\./, '');
    } catch {
      target.company = input.url;
    }
  }
  const reason = target.candidatesTried.length
    ? `No official site could be retrieved and verified (${target.candidatesTried.map((c) => `${c.url}: ${c.outcome}`).join('; ')})`
    : 'No company name or URL to research';
  return { target, status: 'fallback', statusReason: reason, sources, evidence: [], prices: [], percentFees: [], discardedPriceFragments: 0, durationMs: Date.now() - started, corpora: {} };
}

export function researchStatus(sources: SourceRecord[], evidence: Evidence[]): { status: ResearchStatus; reason: string } {
  const ok = sources.filter((s) => s.status === 'ok');
  if (ok.length === 0 || evidence.length === 0) {
    return { status: 'fallback', reason: ok.length === 0 ? 'No source could be retrieved and parsed' : 'Retrieved pages contained no extractable evidence' };
  }
  const notOk = sources.filter((s) => s.status !== 'ok');
  const gaps: string[] = [];
  if (notOk.length > 0) gaps.push(`${notOk.length} of ${sources.length} sources failed or were empty`);
  if (!ok.some((s) => s.kind === 'pricing')) gaps.push('no pricing page was retrieved');
  return gaps.length > 0 ? { status: 'partial', reason: `Partial: ${gaps.join('; ')}` } : { status: 'live', reason: `All ${ok.length} sources retrieved and parsed` };
}
