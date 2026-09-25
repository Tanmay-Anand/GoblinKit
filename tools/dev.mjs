// `pnpm dev`: start the local API and the canvas together, stop both together.
//
// Two processes rather than one, because the API is the real apps/api that
// later grows into the hosted server (ADR-016), and Vite gives the canvas
// instant reloads. Output is prefixed so it is clear which one is talking.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const bin = (p) => fileURLToPath(new URL(`../node_modules/${p}`, import.meta.url));

const procs = [
  ['api', [bin('tsx/dist/cli.mjs'), 'watch', '--clear-screen=false', 'apps/api/src/main.ts']],
  ['web', [bin('vite/bin/vite.js'), '--config', 'apps/web/vite.config.ts']],
].map(([name, args]) => {
  const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  const tag = name === 'api' ? '\x1b[36mapi\x1b[0m' : '\x1b[35mweb\x1b[0m';
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      for (const line of chunk.split(/\r?\n/)) if (line.trim()) process.stdout.write(`${tag} ${line}\n`);
    });
  }
  child.on('exit', (code) => {
    process.stdout.write(`${tag} stopped${code ? ` (exit ${code})` : ''}\n`);
    stopAll();
  });
  return child;
});

let stopping = false;
function stopAll() {
  if (stopping) return;
  stopping = true;
  for (const child of procs) if (child.exitCode === null) child.kill();
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);

process.stdout.write('\nGoblinKit is starting. Open http://127.0.0.1:5173 when "web" says it is ready.\n\n');
