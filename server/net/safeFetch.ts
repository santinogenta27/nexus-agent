import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { Readable } from 'node:stream';
import zlib from 'node:zlib';

export type FetchErrorCode = 'blocked' | 'timeout' | 'http' | 'too_large' | 'content_type' | 'network' | 'redirect';

export class FetchError extends Error {
  readonly code: FetchErrorCode;
  readonly status?: number;

  constructor(code: FetchErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'FetchError';
    this.code = code;
    this.status = status;
  }
}

/** Decides which resolved addresses and ports outbound requests may reach. */
export interface NetworkPolicy {
  isAddressAllowed(ip: string): boolean;
  isPortAllowed(port: number): boolean;
}

const blockList = new net.BlockList();
for (const [prefix, bits] of [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata (169.254.169.254)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
] as const) {
  blockList.addSubnet(prefix, bits, 'ipv4');
}
for (const [prefix, bits] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  // IPv4-mapped (::ffff:0:0/96) is handled in isPublicAddress: BlockList would match every plain IPv4 against it.
  ['64:ff9b::', 96], // NAT64
  ['100::', 64], // discard
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const) {
  blockList.addSubnet(prefix, bits, 'ipv6');
}

/** True only for globally routable unicast addresses. */
export function isPublicAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return !blockList.check(ip, 'ipv4');
  if (!net.isIPv6(ip)) return false;
  const mapped = mappedIPv4(ip);
  if (mapped !== null) return !blockList.check(mapped, 'ipv4');
  return !blockList.check(ip, 'ipv6');
}

/** Expands a valid IPv6 address (including a trailing dotted IPv4) into eight 16-bit groups. */
function ipv6Groups(ip: string): number[] {
  let text = ip.toLowerCase();
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted[1].split('.').map(Number);
    text = `${text.slice(0, -dotted[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = tail !== undefined && tail ? tail.split(':') : [];
  const zeros = tail === undefined ? [] : new Array(8 - left.length - right.length).fill('0');
  return [...left, ...zeros, ...right].map((g) => parseInt(g, 16));
}

/** Returns the embedded IPv4 of an IPv4-mapped IPv6 address (::ffff:a.b.c.d), or null if it is not mapped. */
function mappedIPv4(ip: string): string | null {
  const g = ipv6Groups(ip);
  if (g.length !== 8 || g.slice(0, 5).some((x) => x !== 0) || g[5] !== 0xffff) return null;
  return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
}

export const DEFAULT_POLICY: NetworkPolicy = {
  isAddressAllowed: isPublicAddress,
  isPortAllowed: (port) => port === 80 || port === 443,
};

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.intranet', '.lan', '.home.arpa', '.corp', '.localdomain'];

/** Parses and validates a URL against the policy before any connection is attempted. */
export function validateUrl(raw: string, policy: NetworkPolicy = DEFAULT_POLICY): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchError('blocked', `Invalid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new FetchError('blocked', `Protocol ${url.protocol} is not allowed`);
  if (url.username || url.password) throw new FetchError('blocked', 'URLs with embedded credentials are not allowed');

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) throw new FetchError('blocked', 'URL has no host');
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (!policy.isPortAllowed(port)) throw new FetchError('blocked', `Port ${port} is not allowed`);

  if (net.isIP(host)) {
    if (!policy.isAddressAllowed(host)) throw new FetchError('blocked', `Address ${host} is not a public destination`);
    return url;
  }
  if (host === 'localhost' || BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new FetchError('blocked', `Host ${host} is an internal name`);
  }
  if (!host.includes('.')) throw new FetchError('blocked', `Single-label host ${host} is not allowed`);
  return url;
}

/**
 * DNS lookup that rejects any hostname resolving to a disallowed address. Because the socket connects to the
 * address validated here, a second (rebinding) resolution cannot redirect the connection to an internal host.
 */
function guardedLookup(policy: NetworkPolicy): net.LookupFunction {
  return ((hostname: string, options: dns.LookupOptions, callback: (...args: unknown[]) => void) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) return callback(error);
      const blocked = addresses.find((a) => !policy.isAddressAllowed(a.address));
      if (addresses.length === 0 || blocked) {
        return callback(new FetchError('blocked', `Host ${hostname} resolves to a non-public address (${blocked?.address ?? 'none'})`));
      }
      if (options?.all) return callback(null, addresses);
      return callback(null, addresses[0].address, addresses[0].family);
    });
  }) as net.LookupFunction;
}

export interface FetchOptions {
  policy?: NetworkPolicy;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

export interface FetchedPage {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
  bytes: number;
  redirects: string[];
}

interface HopResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer | null;
}

const USER_AGENT = 'Mozilla/5.0 (compatible; NexusAgentResearch/1.0; +https://github.com)';

function requestHop(url: URL, policy: NetworkPolicy, deadline: number, maxBytes: number): Promise<HopResult> {
  return new Promise((resolve, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return reject(new FetchError('timeout', 'Request timed out'));
    const client = url.protocol === 'https:' ? https : http;
    let settled = false;
    const finish = (error: Error | null, result?: HopResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result as HopResult);
    };

    const req = client.request(
      url,
      {
        method: 'GET',
        agent: false,
        lookup: guardedLookup(policy),
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
          'Accept-Encoding': 'gzip, deflate, br',
          'Accept-Language': 'en-US,en;q=0.8',
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          return finish(null, { status, headers: res.headers, body: null });
        }
        const declared = Number(res.headers['content-length'] ?? 0);
        if (declared > maxBytes) {
          res.destroy();
          return finish(new FetchError('too_large', `Response declares ${declared} bytes (limit ${maxBytes})`));
        }

        const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase();
        let stream: Readable = res;
        if (encoding === 'gzip' || encoding === 'x-gzip') stream = res.pipe(zlib.createGunzip());
        else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());
        else if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress());

        const chunks: Buffer[] = [];
        let total = 0;
        stream.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > maxBytes) {
            res.destroy();
            stream.destroy();
            finish(new FetchError('too_large', `Response exceeded ${maxBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        stream.on('end', () => finish(null, { status, headers: res.headers, body: Buffer.concat(chunks) }));
        stream.on('error', (error) => finish(new FetchError('network', `Failed to read response: ${error.message}`)));
      },
    );

    const timer = setTimeout(() => {
      req.destroy();
      finish(new FetchError('timeout', 'Request timed out'));
    }, remaining);

    req.on('error', (error) => {
      if (error instanceof FetchError) return finish(error);
      const cause = (error as { cause?: unknown }).cause;
      if (cause instanceof FetchError) return finish(cause);
      finish(new FetchError('network', error.message));
    });
    req.end();
  });
}

function decodeBody(body: Buffer, contentType: string): string {
  const charset = /charset=([\w-]+)/i.exec(contentType)?.[1]?.toLowerCase() ?? 'utf-8';
  try {
    return new TextDecoder(charset).decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}

/** Fetches an HTML page with SSRF protection, per-hop redirect validation, a total timeout and a size cap. */
export async function fetchPage(rawUrl: string, options: FetchOptions = {}): Promise<FetchedPage> {
  const policy = options.policy ?? DEFAULT_POLICY;
  const maxBytes = options.maxBytes ?? 3_000_000;
  const maxRedirects = options.maxRedirects ?? 3;
  const deadline = Date.now() + (options.timeoutMs ?? 8_000);

  let url = validateUrl(rawUrl, policy);
  const redirects: string[] = [];
  for (let hop = 0; ; hop += 1) {
    const result = await requestHop(url, policy, deadline, maxBytes);
    if (result.status >= 300 && result.status < 400 && result.headers.location) {
      if (hop >= maxRedirects) throw new FetchError('redirect', `Too many redirects (limit ${maxRedirects})`);
      let next: URL;
      try {
        next = new URL(result.headers.location, url);
      } catch {
        throw new FetchError('redirect', `Invalid redirect location: ${result.headers.location}`);
      }
      try {
        url = validateUrl(next.toString(), policy);
      } catch (error) {
        throw new FetchError('blocked', `Unsafe redirect to ${next.toString()}: ${(error as Error).message}`);
      }
      redirects.push(url.toString());
      continue;
    }
    if (result.status >= 400) throw new FetchError('http', `HTTP ${result.status}`, result.status);
    const contentType = String(result.headers['content-type'] ?? '');
    if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
      throw new FetchError('content_type', `Unsupported content type: ${contentType || 'none'}`);
    }
    const body = result.body ?? Buffer.alloc(0);
    return {
      requestedUrl: rawUrl,
      finalUrl: url.toString(),
      status: result.status,
      contentType,
      body: decodeBody(body, contentType),
      bytes: body.length,
      redirects,
    };
  }
}
