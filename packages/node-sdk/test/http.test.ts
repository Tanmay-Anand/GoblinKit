import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';

import { createHttpClient, MockHttp, NodeFailure, type HttpRequest } from '@goblin/node-sdk';

const signal = () => new AbortController().signal;
const get = (url: string, extra: Partial<HttpRequest> = {}): HttpRequest => ({ method: 'GET', url, signal: signal(), timeoutMs: 5_000, ...extra });

async function failure(promise: Promise<unknown>): Promise<NodeFailure> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof NodeFailure) return error;
    throw error;
  }
  throw new Error('expected the request to fail');
}

describe('ctx.http timing', () => {
  it('reports time to first byte and total time, from its own clock', async () => {
    const http = new MockHttp();
    http.mock('GET https://api.test/users').reply(200, { users: [] }, { ttfbMs: 40, totalMs: 120 });
    const res = await http.client().request(get('https://api.test/users'));
    expect(res.timing).toEqual({ ttfbMs: 40, totalMs: 120 });
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ users: [] });
    expect(res.bytes).toBe(JSON.stringify({ users: [] }).length);
  });

  it('bytes is the decoded size: a gzip body counts what it unpacks to', async () => {
    // Against a real server, because decoding is fetch's job and must not be mocked away.
    const body = JSON.stringify({ rows: Array.from({ length: 200 }, (_, i) => ({ i, name: `row ${i}` })) });
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
      res.end(gzipSync(body));
    });
    const url = await listen(server);
    const res = await createHttpClient().request(get(url));
    expect(res.bytes).toBe(body.length);
    expect(res.timing.totalMs).toBeGreaterThanOrEqual(res.timing.ttfbMs);
  });
});

describe('ctx.http limits', () => {
  it('fails, never truncates, past the size cap — as a validation error', async () => {
    const http = new MockHttp();
    http.mock('GET https://api.test/big').reply(200, 'x'.repeat(2048));
    const error = await failure(http.client().request(get('https://api.test/big', { maxResponseBytes: 1024 })));
    expect(error.code).toBe('RESPONSE_TOO_LARGE');
    expect(error.errorClass).toBe('validation');
    expect(error.retryable).toBe(false);
  });

  it('trusts a content-length that is already over the cap, without reading the body', async () => {
    const http = new MockHttp();
    http.mock('GET https://api.test/big').reply(200, 'small', { headers: { 'content-length': String(50 * 1024 * 1024) } });
    const error = await failure(http.client().request(get('https://api.test/big')));
    expect(error.code).toBe('RESPONSE_TOO_LARGE');
  });

  it('gives up at its timeout, and says so', async () => {
    const http = new MockHttp();
    http.mock('GET https://api.test/slow').hang();
    const error = await failure(http.client().request(get('https://api.test/slow', { timeoutMs: 20 })));
    expect(error.code).toBe('TIMEOUT');
    expect(error.message).toMatch(/did not answer within 0\.02 s/);
    expect(error.retryable).toBe(true);
  });

  it('stops when the box is cancelled, and that is not retried', async () => {
    const http = new MockHttp();
    http.mock('GET https://api.test/slow').hang();
    const controller = new AbortController();
    const pending = http.client().request({ ...get('https://api.test/slow'), signal: controller.signal });
    controller.abort();
    const error = await failure(pending);
    expect(error.code).toBe('CANCELLED');
    expect(error.retryable).toBe(false);
  });

  it('never retries: one call, however the first one went', async () => {
    const http = new MockHttp();
    http.mock('GET https://api.test/flaky').fail('ECONNRESET', 1).reply(200, {});
    const error = await failure(http.client().request(get('https://api.test/flaky')));
    expect(error.code).toBe('ECONNRESET');
    expect(http.calls).toHaveLength(1);
  });
});

describe('ctx.http egress', () => {
  it('lets a local-mode box call this machine, and a hosted one not', async () => {
    const http = new MockHttp();
    http.mock('GET http://localhost:8080/health').reply(200, 'ok');
    expect((await http.client({ mode: 'local' }).request(get('http://localhost:8080/health'))).status).toBe(200);
    for (const url of ['http://localhost:8080/health', 'http://127.0.0.1/x', 'http://[::1]/x']) {
      expect((await failure(http.client({ mode: 'hosted' }).request(get(url)))).code).toBe('EGRESS_BLOCKED');
    }
  });

  it('never calls the cloud metadata address, in any mode', async () => {
    const error = await failure(new MockHttp().client({ mode: 'local' }).request(get('http://169.254.169.254/latest/meta-data')));
    expect(error.code).toBe('EGRESS_BLOCKED');
  });

  it('refuses addresses that are not http or https', async () => {
    expect((await failure(new MockHttp().client().request(get('file:///etc/passwd')))).code).toBe('BAD_URL');
    expect((await failure(new MockHttp().client().request(get('not a url')))).code).toBe('BAD_URL');
  });
});

describe('ctx.http credentials', () => {
  it('merges httpAuth headers, the credential winning over a box header of the same name', async () => {
    const http = new MockHttp();
    http.mock('GET https://api.test/me').reply(200, {});
    await http.client().request(
      get('https://api.test/me', {
        headers: { Authorization: 'from the box', 'x-tenant-id': 't1' },
        auth: { capability: 'httpAuth@1', value: { headers: { authorization: 'Bearer secret-token' } } },
      }),
    );
    expect(http.calls[0]!.headers).toEqual({ authorization: 'Bearer secret-token', 'x-tenant-id': 't1' });
  });

  it('lets an httpSigner rewrite the finished request', async () => {
    const http = new MockHttp();
    http.mock('POST https://api.test/items*').reply(201, {});
    await http.client().request({
      ...get('https://api.test/items?page=1'),
      method: 'POST',
      body: { name: 'a' },
      auth: {
        capability: 'httpSigner@1',
        value: {
          sign: (r) => ({ ...r, url: `${r.url}&api_key=k`, headers: { ...r.headers, 'x-signature': `sig(${String(r.body)})` } }),
        },
      },
    });
    const call = http.calls[0]!;
    expect(call.url).toBe('https://api.test/items?page=1&api_key=k');
    // The signer saw the exact bytes that were sent.
    expect(call.headers['x-signature']).toBe('sig({"name":"a"})');
    expect(call.headers['content-type']).toBe('application/json');
  });

  it('sends no body with GET', async () => {
    const http = new MockHttp();
    http.mock('GET https://api.test/x').reply(200, {});
    await http.client().request(get('https://api.test/x', { body: { ignored: true } }));
    expect(http.calls[0]!.body).toBeUndefined();
  });
});

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

async function listen(s: Server): Promise<string> {
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}/`;
}
