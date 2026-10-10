import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import zlib from 'node:zlib';
import { FetchError, fetchPage, isPublicAddress, validateUrl } from '../server/net/safeFetch.ts';
import { LOOPBACK_TEST_POLICY, html, sendHtml, startServer } from './helpers.ts';
import type { TestServer } from './helpers.ts';

async function expectFetchError(promise: Promise<unknown>, code: FetchError['code']): Promise<FetchError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof FetchError, `expected FetchError, got ${String(error)}`);
    assert.equal(error.code, code, `expected code ${code}, got ${error.code}: ${error.message}`);
    return error;
  }
  assert.fail(`expected FetchError ${code}`);
}

describe('isPublicAddress', () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.4.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:a9fe:a9fe', '::ffff:10.0.0.1']) {
    it(`blocks ${ip}`, () => assert.equal(isPublicAddress(ip), false));
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    it(`allows ${ip}`, () => assert.equal(isPublicAddress(ip), true));
  }
});

describe('validateUrl (default policy)', () => {
  const blocked = [
    'http://localhost/',
    'http://api.localhost/',
    'http://127.0.0.1/',
    'http://[::1]/',
    'http://169.254.169.254/latest/meta-data/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://0x7f000001/',
    'http://2130706433/',
    'http://10.0.0.1/',
    'http://intranet/',
    'ftp://example.com/',
    'file:///etc/passwd',
    'http://user:pass@example.com/',
    'https://example.com:8443/',
  ];
  for (const url of blocked) {
    it(`blocks ${url}`, () => assert.throws(() => validateUrl(url), (e: unknown) => e instanceof FetchError && e.code === 'blocked'));
  }
  it('allows a public https URL', () => assert.equal(validateUrl('https://example.com/pricing').hostname, 'example.com'));
});

describe('fetchPage against a local server', () => {
  let server: TestServer;
  let target: TestServer;

  before(async () => {
    target = await startServer({ '/final': sendHtml(html('<h1>Final page</h1>')) });
    server = await startServer({
      '/ok': sendHtml(html('<h1>Hello</h1><p>Valid page</p>')),
      '/slow': (_req, res) => {
        setTimeout(() => sendHtml(html('<p>late</p>'))(_req, res), 2_000);
      },
      '/redirect-metadata': (_req, res) => {
        res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
        res.end();
      },
      '/redirect-localhost': (_req, res) => {
        res.writeHead(302, { Location: `http://localhost:${server.port}/ok` });
        res.end();
      },
      '/redirect-private': (_req, res) => {
        res.writeHead(301, { Location: 'http://10.0.0.1/admin' });
        res.end();
      },
      '/redirect-safe': (_req, res) => {
        res.writeHead(302, { Location: `${target.origin}/final` });
        res.end();
      },
      '/loop': (_req, res) => {
        res.writeHead(302, { Location: '/loop' });
        res.end();
      },
      '/big': sendHtml(html(`<p>${'x'.repeat(5_000)}</p>`)),
      '/json': (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"a":1}');
      },
      '/gzip': (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' });
        res.end(zlib.gzipSync(html('<p>compressed content</p>')));
      },
      '/empty': sendHtml(''),
      '/server-error': sendHtml(html('<p>boom</p>'), 500),
    });
  });
  after(async () => {
    await server.close();
    await target.close();
  });

  it('fetches a valid URL', async () => {
    const page = await fetchPage(`${server.origin}/ok`, { policy: LOOPBACK_TEST_POLICY });
    assert.equal(page.status, 200);
    assert.match(page.body, /Valid page/);
    assert.deepEqual(page.redirects, []);
  });

  it('rejects the loopback server under the default policy', async () => {
    await expectFetchError(fetchPage(`${server.origin}/ok`), 'blocked');
  });

  it('reports an inaccessible URL (connection refused)', async () => {
    const closed = await startServer({});
    const origin = closed.origin;
    await closed.close();
    await expectFetchError(fetchPage(`${origin}/`, { policy: LOOPBACK_TEST_POLICY, timeoutMs: 2_000 }), 'network');
  });

  it('reports HTTP errors with their status', async () => {
    const error = await expectFetchError(fetchPage(`${server.origin}/missing`, { policy: LOOPBACK_TEST_POLICY }), 'http');
    assert.equal(error.status, 404);
    await expectFetchError(fetchPage(`${server.origin}/server-error`, { policy: LOOPBACK_TEST_POLICY }), 'http');
  });

  it('times out slow responses', async () => {
    const started = Date.now();
    await expectFetchError(fetchPage(`${server.origin}/slow`, { policy: LOOPBACK_TEST_POLICY, timeoutMs: 300 }), 'timeout');
    assert.ok(Date.now() - started < 1_500, 'timeout should fire close to the limit');
  });

  it('blocks a redirect to the cloud metadata endpoint', async () => {
    await expectFetchError(fetchPage(`${server.origin}/redirect-metadata`, { policy: LOOPBACK_TEST_POLICY }), 'blocked');
  });

  it('blocks a redirect to localhost by name', async () => {
    await expectFetchError(fetchPage(`${server.origin}/redirect-localhost`, { policy: LOOPBACK_TEST_POLICY }), 'blocked');
  });

  it('blocks a redirect to a private address', async () => {
    await expectFetchError(fetchPage(`${server.origin}/redirect-private`, { policy: LOOPBACK_TEST_POLICY }), 'blocked');
  });

  it('follows a safe redirect and reports the final URL', async () => {
    const page = await fetchPage(`${server.origin}/redirect-safe`, { policy: LOOPBACK_TEST_POLICY });
    assert.equal(page.finalUrl, `${target.origin}/final`);
    assert.equal(page.redirects.length, 1);
  });

  it('stops redirect loops', async () => {
    await expectFetchError(fetchPage(`${server.origin}/loop`, { policy: LOOPBACK_TEST_POLICY, maxRedirects: 3 }), 'redirect');
  });

  it('enforces the response size limit', async () => {
    await expectFetchError(fetchPage(`${server.origin}/big`, { policy: LOOPBACK_TEST_POLICY, maxBytes: 1_000 }), 'too_large');
  });

  it('rejects non-HTML content', async () => {
    await expectFetchError(fetchPage(`${server.origin}/json`, { policy: LOOPBACK_TEST_POLICY }), 'content_type');
  });

  it('decodes gzip responses', async () => {
    const page = await fetchPage(`${server.origin}/gzip`, { policy: LOOPBACK_TEST_POLICY });
    assert.match(page.body, /compressed content/);
  });

  it('returns empty bodies without inventing content', async () => {
    const page = await fetchPage(`${server.origin}/empty`, { policy: LOOPBACK_TEST_POLICY });
    assert.equal(page.body, '');
  });
});

describe('DNS rebinding guard', () => {
  it('blocks a public hostname that resolves to loopback', async (t) => {
    try {
      await dns.lookup('localtest.me');
    } catch {
      t.skip('DNS unavailable in this environment');
      return;
    }
    await expectFetchError(fetchPage('http://localtest.me/', { timeoutMs: 3_000 }), 'blocked');
  });
});
