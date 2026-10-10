import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { researchCompany } from '../server/research/retrieve.ts';
import { FILLER, LOOPBACK_TEST_POLICY, html, sendHtml, startServer } from './helpers.ts';
import type { TestServer } from './helpers.ts';

function siteRoutes(name: string, tagline: string, pricing: string, pricingStatus = 200) {
  return {
    '/': sendHtml(
      html(
        `<nav><a href="/pricing">Pricing</a><a href="/features">Features</a><a href="/docs">Docs</a><a href="/login">Log in</a></nav>
         <h1>${tagline}</h1>${FILLER}<p>Built for engineering teams that ship fast.</p><a href="/signup">Get started</a><p>Sign up in minutes.</p>`,
        `<title>${name} — ${tagline}</title><meta name="description" content="${name} helps teams ${tagline.toLowerCase()}.">`,
      ),
    ),
    '/pricing': sendHtml(html(pricing), pricingStatus),
    '/features': sendHtml(html(`<h1>${name} features</h1>${FILLER}<ul><li>Real-time collaboration across every project</li><li>Automated workflows for recurring tasks</li></ul>`)),
    '/docs': sendHtml(html(`<h1>${name} Documentation</h1>${FILLER}`, `<title>${name} Docs</title>`)),
  };
}

const ACME_PRICING = `<h1>Pricing</h1>${FILLER}<h2>Starter</h2><p>$0 per month</p><p>Free plan for individuals</p><h2>Team</h2><p>$12 per user/month</p><h2>Business</h2><p>$240 per year</p><p>Enterprise: contact sales for custom pricing</p><p>No credit card required</p>`;
const GLOBEX_PRICING = `<h1>Plans</h1>${FILLER}<p>€49/month for the Pro plan</p><p>Request a demo for Enterprise</p><p>Billed annually</p>`;

describe('researchCompany', () => {
  let acme: TestServer;
  let globex: TestServer;
  let broken: TestServer;
  let empty: TestServer;

  before(async () => {
    acme = await startServer(siteRoutes('Acme', 'Plan projects without friction', ACME_PRICING));
    globex = await startServer(siteRoutes('Globex', 'Logistics analytics for retailers', GLOBEX_PRICING));
    broken = await startServer(siteRoutes('Brokenco', 'Analytics for marketers', '<p>error</p>', 500));
    empty = await startServer({ '/': sendHtml(html('<div id="root"></div>', '<title>App</title>')) });
  });
  after(async () => {
    await Promise.all([acme.close(), globex.close(), broken.close(), empty.close()]);
  });

  it('researches a valid URL as live research with verifiable evidence', async () => {
    const result = await researchCompany({ company: 'Acme', url: `${acme.origin}/` }, { policy: LOOPBACK_TEST_POLICY });
    assert.equal(result.status, 'live', result.statusReason);
    assert.equal(result.target.resolvedBy, 'user_url');
    assert.deepEqual(result.sources.map((s) => s.kind).sort(), ['docs', 'home', 'pricing', 'product']);
    assert.ok(result.sources.every((s) => s.status === 'ok'));
    assert.ok(!result.sources.some((s) => s.url.includes('/login')), 'login pages are excluded');

    const kinds = new Set(result.evidence.map((e) => e.kind));
    for (const k of ['value_prop', 'feature', 'audience', 'pricing', 'custom_pricing', 'friction', 'docs']) assert.ok(kinds.has(k as never), `missing ${k}`);
    assert.deepEqual(
      result.prices.map((p) => [p.product, p.amount, p.currency, p.period, p.unit]),
      [
        ['Starter', 0, 'USD', 'month', null],
        ['Team', 12, 'USD', 'month', 'user'],
        ['Business', 240, 'USD', 'year', null],
      ],
    );
    // The plan-linked enterprise sentence counts as a sales step; the "No credit card" phrase is a self-serve signal.
    assert.ok(result.evidence.some((e) => e.signal === 'contact_sales' && e.contextual === true));
    assert.ok(result.evidence.some((e) => e.signal === 'no_credit_card'));
    // Every snippet is verbatim text from the page it cites.
    for (const e of result.evidence) assert.ok(result.corpora[e.sourceId].includes(e.snippet), `${e.id} not in corpus`);
  });

  it('produces evidence from each company\'s own pages', async () => {
    const a = await researchCompany({ url: `${acme.origin}/` }, { policy: LOOPBACK_TEST_POLICY });
    const g = await researchCompany({ url: `${globex.origin}/` }, { policy: LOOPBACK_TEST_POLICY });
    assert.match(a.target.company, /Acme/);
    assert.match(g.target.company, /Globex/);
    assert.ok(a.evidence.every((e) => e.url.startsWith(acme.origin)));
    assert.ok(g.evidence.every((e) => e.url.startsWith(globex.origin)));
    assert.ok(g.evidence.some((e) => e.snippet.includes('Logistics analytics')));
    assert.ok(!g.evidence.some((e) => e.snippet.includes('Plan projects')), 'no cross-company leakage');
    assert.deepEqual(g.prices.map((p) => [p.amount, p.currency, p.period]), [[49, 'EUR', 'month']]);
  });

  it('marks research partial when a page fails, and keeps going with accessible sources', async () => {
    const result = await researchCompany({ url: `${broken.origin}/` }, { policy: LOOPBACK_TEST_POLICY });
    assert.equal(result.status, 'partial');
    const pricing = result.sources.find((s) => s.kind === 'pricing');
    assert.equal(pricing?.status, 'failed');
    assert.match(pricing?.error ?? '', /HTTP 500/);
    assert.ok(!result.evidence.some((e) => e.sourceId === pricing?.id), 'no evidence from a failed source');
    assert.equal(result.prices.length, 0);
    assert.ok(result.evidence.length > 0);
  });

  it('falls back (no evidence) when the URL is unreachable', async () => {
    const closed = await startServer({});
    const origin = closed.origin;
    await closed.close();
    const result = await researchCompany({ url: `${origin}/` }, { policy: LOOPBACK_TEST_POLICY, perRequestTimeoutMs: 2_000 });
    assert.equal(result.status, 'fallback');
    assert.equal(result.evidence.length, 0);
    assert.equal(result.sources[0].status, 'failed');
    assert.ok(result.sources[0].error);
  });

  it('treats pages without visible text as empty, not as research', async () => {
    const result = await researchCompany({ url: `${empty.origin}/` }, { policy: LOOPBACK_TEST_POLICY });
    assert.equal(result.status, 'fallback');
    assert.equal(result.sources[0].status, 'empty');
    assert.equal(result.evidence.length, 0);
  });

  it('blocks internal URLs under the default policy', async () => {
    const result = await researchCompany({ url: 'http://169.254.169.254/latest/meta-data/' });
    assert.equal(result.status, 'fallback');
    assert.equal(result.sources[0].status, 'blocked');
  });

  it('respects the time budget', async () => {
    const slow = await startServer({
      '/': (_req, res) => {
        setTimeout(() => sendHtml(html('<p>late</p>'))(_req, res), 3_000);
      },
    });
    const started = Date.now();
    const result = await researchCompany({ url: `${slow.origin}/` }, { policy: LOOPBACK_TEST_POLICY, budgetMs: 800 });
    await slow.close();
    assert.ok(Date.now() - started < 2_000);
    assert.equal(result.status, 'fallback');
    assert.match(result.sources[0].error ?? '', /timed out/i);
  });
});
