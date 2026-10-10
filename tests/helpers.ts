import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NetworkPolicy } from '../server/net/safeFetch.ts';

export type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

export interface TestServer {
  origin: string;
  port: number;
  close: () => Promise<void>;
}

/** Starts a loopback HTTP server whose routes are matched by exact path. Unknown paths return 404. */
export async function startServer(routes: Record<string, Handler>): Promise<TestServer> {
  const server = http.createServer((req, res) => {
    const handler = routes[new URL(req.url ?? '/', 'http://x').pathname];
    if (handler) handler(req, res);
    else {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('<html><body>not found</body></html>');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export const html = (body: string, head = '') => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

export function sendHtml(content: string, status = 200): Handler {
  return (_req, res) => {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(content);
  };
}

/**
 * Test-only policy: allows the loopback test server (any port) and nothing else, so the same SSRF code paths
 * still reject cloud-metadata and private targets.
 */
export const LOOPBACK_TEST_POLICY: NetworkPolicy = {
  isAddressAllowed: (ip) => ip === '127.0.0.1',
  isPortAllowed: () => true,
};

/** Paragraph filler so pages clear the minimum visible-text threshold. */
export const FILLER = '<p>' + 'This page describes the product in enough detail for the research agent to analyse it properly. '.repeat(4) + '</p>';
