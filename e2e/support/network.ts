import { createServer } from 'node:net';

/** A local port with nothing listening on it: bound, read, and released. */
export async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (!address || typeof address === 'string') throw new Error('Could not find a free port.');
  return address.port;
}
