import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A stand-in for the dev API the endpoint-latency example measures: old
 * endpoints return whole rows, new ones a few fields. It records what it was
 * sent, so a test can see the credential arrived, and it can be told to make
 * one endpoint slow, for a regression.
 */
export async function startStubApi(): Promise<{
  url: string;
  requests: { path: string; headers: IncomingHttpHeaders }[];
  slowDown(path: string, ms: number): void;
  close(): Promise<void>;
}> {
  const requests: { path: string; headers: IncomingHttpHeaders }[] = [];
  const slow = new Map<string, number>();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://stub');
    requests.push({ path: url.pathname + url.search, headers: req.headers });
    const small = url.pathname.endsWith('/autocomplete') || url.searchParams.get('view') === 'list';
    const body = small ? { items: [{ id: 1, name: 'A' }] } : { rows: Array.from({ length: 40 }, (_, i) => ({ id: i, name: `Row ${i}`, notes: 'x'.repeat(50) })) };
    // Tens of milliseconds, not one or two: timer jitter must stay well under
    // the 20% a regression takes, or a steady endpoint would look like one.
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    }, slow.get(url.pathname) ?? (small ? 30 : 60));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    slowDown: (path, ms) => slow.set(path, ms),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
