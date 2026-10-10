import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyEvidence, diagnoseLowContent, extractEmbeddedText, extractPage, parsePriceCard } from '../server/research/extract.ts';
import type { PriceCard } from '../server/research/extract.ts';

const card = (lines: string[], heading: string | null): PriceCard => ({ lines, heading, snippet: lines.join(' ') });

describe('extractPage', () => {
  it('drops scripts and styles and never evaluates them', () => {
    const page = extractPage(
      '<html><head><title>T</title><script>globalThis.pwned = true; document.write("injected")</script><style>body{}</style></head><body><h1>Visible</h1><script>alert(1)</script><p>Text</p></body></html>',
      'https://example.com/',
    );
    assert.equal((globalThis as { pwned?: boolean }).pwned, undefined);
    assert.ok(!page.corpus.includes('injected'));
    assert.ok(!page.corpus.includes('alert'));
    assert.deepEqual(page.h1, ['Visible']);
  });

  it('keeps word boundaries between block elements inside headings', () => {
    const page = extractPage('<body><h1><div>Build in a weekend</div><div>Scale to millions</div></h1></body>', 'https://example.com/');
    assert.deepEqual(page.h1, ['Build in a weekend Scale to millions']);
    assert.ok(page.corpus.includes(page.h1[0]));
  });

  it('resolves links relative to the page and skips non-http schemes', () => {
    const page = extractPage('<a href="/pricing">Pricing</a><a href="mailto:x@y.z">Mail</a><a href="javascript:void(0)">JS</a>', 'https://example.com/a/');
    assert.deepEqual(page.links, [{ href: 'https://example.com/pricing', text: 'Pricing' }]);
  });

  it('handles empty documents', () => {
    const page = extractPage('', 'https://example.com/');
    assert.equal(page.textChars, 0);
    assert.deepEqual(page.lines, []);
    assert.deepEqual(page.priceCards, []);
  });

  it('ties each price card to the nearest product heading, not to generic page headings', () => {
    const page = extractPage(
      `<body><h1>Pricing</h1><h2>Starter</h2><div class="card"><p>$0</p><p>per month</p></div>
       <h2>Team</h2><div class="card"><span>$12</span> per user/month</div></body>`,
      'https://example.com/pricing',
    );
    assert.deepEqual(
      page.priceCards.map((c) => [c.heading, c.snippet]),
      [
        ['Starter', '$0 per month'],
        ['Team', '$12 per user/month'],
      ],
    );
    for (const c of page.priceCards) assert.ok(page.corpus.includes(c.snippet));
  });

  it('uses enclosing structure, so a price never inherits a sibling section heading', () => {
    const page = extractPage(
      `<body>
         <section><header><h2>Billing</h2></header><div><div><h3>Pay monthly</h3></div><div><p>Starting at $620 per month</p></div></div></section>
         <section><div><p>Domain $10 per month</p></div></section>
       </body>`,
      'https://example.com/pricing',
    );
    assert.deepEqual(page.priceCards.map((c) => c.heading), ['Billing › Pay monthly', null], 'the second section has no heading: product unknown');
  });

  it('labels peer plan cards by their own heading, not by a neighbouring card', () => {
    const page = extractPage(
      `<body><h2>Choose a plan</h2><div class="row"><div><h3>Free</h3><p>$0 per month</p></div><div><h3>Plus</h3><p>$10 per month</p></div></div></body>`,
      'https://example.com/pricing',
    );
    assert.deepEqual(page.priceCards.map((c) => c.heading), ['Free', 'Plus']);
  });

  it('does not treat taglines, lead-ins or counters as product names', () => {
    const page = extractPage(
      `<body><section><h2>One tool to run your company.</h2><div><p>Team $8 per seat/month</p></div></section>
       <section><h2>Features available out of the box:</h2><div><p>Atlas $500 one-time</p></div></section>
       <section><h2>130</h2><div><p>Card $2 per card</p></div></section></body>`,
      'https://example.com/pricing',
    );
    assert.deepEqual(page.priceCards.map((c) => c.heading), [null, null, null]);
  });

  it('ignores prices buried in long marketing copy', () => {
    const page = extractPage(`<body><h2>Story</h2><p>${'We grew fast. '.repeat(30)} Customers saved $5 last year.</p></body>`, 'https://example.com/pricing');
    assert.equal(page.priceCards.length, 0);
  });
});

describe('content that used to be lost', () => {
  it('keeps the page after a Declarative Shadow DOM template (Linear-style markup)', () => {
    const page = extractPage(
      `<body><h1>Pricing</h1><section><h3>Basic</h3><span aria-hidden="true"><number-flow-react aria-label="$10 per user/month">
         <template shadowroot="open" shadowrootmode="open"><style>:host{display:inline-block}span{display:inline-block}</style></template></number-flow-react></span>
         <span>$10 per user/month</span></section>
         <section><h3>Business</h3><span>$16 per user/month</span></section></body>`,
      'https://example.com/pricing',
    );
    // Both plans after the template are parsed; each card is the plan section (heading + visible price).
    assert.deepEqual(page.priceCards.map((c) => [c.heading, c.snippet]), [
      ['Basic', 'Basic $10 per user/month'],
      ['Business', 'Business $16 per user/month'],
    ]);
    assert.ok(!page.corpus.includes(':host'), 'template styles are not treated as text');
  });
});

describe('diagnoseLowContent', () => {
  const diagnose = (html: string) => diagnoseLowContent(html, extractPage(html, 'https://example.com/')).reason;
  it('recognises bot checks and access-denied pages', () => {
    assert.equal(diagnose('<html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>'), 'blocked');
  });
  it('recognises error pages', () => {
    assert.equal(diagnose('<html><head><title>404 Not Found</title></head><body>Missing</body></html>'), 'error_page');
  });
  it('recognises JavaScript app shells without calling every short page an SPA', () => {
    assert.equal(diagnose('<html><body><div id="root"></div><script src="/a.js"></script></body></html>'), 'client_rendered');
    assert.equal(diagnose('<html><head><title>Acme</title></head><body><p>Coming soon.</p></body></html>'), 'empty');
  });
});

describe('extractEmbeddedText', () => {
  it('reads human-readable strings from JSON-LD and embedded JSON only', () => {
    const html = `<script type="application/ld+json">{"@type":"Product","name":"Acme Team plan","offers":{"price":"12","priceCurrency":"USD","description":"$12 per user/month"}}</script>
      <script id="__NEXT_DATA__" type="application/json">{"props":{"plan":"Team plan for growing companies","css":"a{b:c}","url":"https://x.test/a"}}</script>
      <script>globalThis.embeddedRan = true; var s = "Executable script text";</script>`;
    const strings = extractEmbeddedText(html);
    assert.ok(strings.includes('Acme Team plan'));
    assert.ok(strings.includes('$12 per user/month'));
    assert.ok(strings.includes('Team plan for growing companies'));
    assert.ok(!strings.some((s) => s.includes('Executable script text')), 'plain scripts are not read');
    assert.ok(!strings.some((s) => s.startsWith('https://') || s.includes('{')), 'URLs and code-like strings are skipped');
    assert.equal((globalThis as { embeddedRan?: boolean }).embeddedRan, undefined, 'nothing is executed');
  });
  it('ignores malformed embedded JSON', () => {
    assert.deepEqual(extractEmbeddedText('<script type="application/ld+json">{not json</script>'), []);
  });
});

describe('parsePriceCard', () => {
  it('keeps product, unit and billing period stated next to the price', () => {
    const { prices } = parsePriceCard(card(['$12 per user/month'], 'Team'), 'E1');
    assert.deepEqual(prices, [{ evidenceId: 'E1', amount: 12, currency: 'USD', product: 'Team', item: null, unit: 'user', period: 'month', terms: [] }]);
  });

  it('reads line items and per-event units (Stripe-style tariff)', () => {
    const { prices } = parsePriceCard(card(['Dispute received fee $15.00', 'for each dispute you receive.'], 'Disputes'), 'E2');
    assert.deepEqual(
      prices.map((p) => [p.product, p.item, p.amount, p.unit, p.period]),
      [['Disputes', 'Dispute received fee', 15, 'dispute you receive', null]],
    );
  });

  it('parses percentage + fixed fees with their product and unit', () => {
    const { percentFees, prices } = parsePriceCard(card(['2.9% + 30¢', 'per successful transaction for domestic cards'], 'Standard'), 'E3');
    assert.deepEqual(percentFees, [
      { evidenceId: 'E3', percent: 2.9, fixedAmount: 0.3, fixedCurrency: 'USD', product: 'Standard', item: null, unit: 'successful transaction for domestic cards' },
    ]);
    assert.equal(prices.length, 0, 'the fixed part of a fee is not a separate price');
  });

  it('discards isolated amounts that cannot be linked to a product or rate', () => {
    const result = parsePriceCard(card(['$5'], null), 'E4');
    assert.equal(result.prices.length, 0);
    assert.equal(result.discarded, 1);
  });

  it('never infers a missing billing period', () => {
    const { prices } = parsePriceCard(card(['Only £5'], 'Pro'), 'E5');
    assert.deepEqual(prices.map((p) => [p.product, p.currency, p.period, p.unit]), [['Pro', 'GBP', null, null]]);
  });

  it('handles thousands separators, yearly prices and stated terms', () => {
    assert.deepEqual(
      parsePriceCard(card(['€1,200/year, billed annually'], 'Business'), 'E6').prices.map((p) => [p.amount, p.currency, p.period, p.terms]),
      [[1200, 'EUR', 'year', ['Billed annually']]],
    );
    assert.equal(parsePriceCard(card(['$10 per 1,000 credits'], 'Agents'), 'E7').prices[0].unit, '1,000 credits');
  });

  it('tolerates text glued together by markup', () => {
    const { prices } = parsePriceCard(card(['Plus$10 per seat/monthGet started'], null), 'E8');
    assert.deepEqual(prices.map((p) => [p.item, p.unit, p.period]), [['Plus', 'seat', 'month']]);
  });

  it('keeps a stated scope after the period as the unit, so per-project add-ons are not read as plan prices', () => {
    const { prices } = parsePriceCard(card(['$75 per month for first project'], 'Auth'), 'E10');
    assert.deepEqual(prices.map((p) => [p.amount, p.period, p.unit]), [[75, 'month', 'first project']]);
  });

  it('keeps "Starting at" and contract length as terms, not as the line item', () => {
    const { prices } = parsePriceCard(card(['Starting at $620.00', 'per month, 1-year contract'], 'Billing'), 'E9');
    assert.deepEqual(prices.map((p) => [p.item, p.period, p.terms]), [[null, 'month', ['Starting at', '1-year contract']]]);
  });
});

describe('friction signals', () => {
  const classify = (body: string, kind: 'pricing' | 'home' = 'pricing') => {
    let n = 0;
    return classifyEvidence(extractPage(`<body>${body}</body>`, 'https://example.com/pricing'), { id: 'S1', url: 'https://example.com/pricing', kind }, () => `E${++n}`).evidence.filter(
      (e) => e.kind === 'friction',
    );
  };

  it('ignores negated cost phrases', () => {
    const friction = classify('<p>Simple pricing. No setup fees, monthly fees, or hidden fees.</p>');
    assert.ok(!friction.some((e) => e.signal === 'setup_fee'));
  });

  it('marks a generic "Contact sales" button as non-contextual', () => {
    const friction = classify('<div>Start now Contact sales</div>', 'home');
    const sales = friction.find((e) => e.signal === 'contact_sales');
    assert.equal(sales?.contextual, false);
  });

  it('marks a plan-linked sales step as contextual', () => {
    const friction = classify('<div>Start now Contact sales</div><p>Enterprise: contact sales for custom pricing and volume discounts.</p>');
    const sales = friction.find((e) => e.signal === 'contact_sales');
    assert.equal(sales?.contextual, true);
    assert.match(sales?.snippet ?? '', /Enterprise/);
  });
});
