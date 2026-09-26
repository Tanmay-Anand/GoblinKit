// `pnpm dev`: start the local API and the canvas together, stop both together.
//
// Two processes rather than one, because the API is the real apps/api that
// later grows into the hosted server (ADR-016), and Vite gives the canvas
// instant reloads. Output is prefixed so it is clear which one is talking.
//
//   node tools/dev.mjs           start both
//   node tools/dev.mjs --open    ...and open the browser once both answer
//
// Ports come from GOBLIN_WEB_PORT / GOBLIN_API_PORT (default 5173 / 8787).
// GOBLIN_NO_BROWSER=1 makes --open print what it would open instead.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const bin = (p) => fileURLToPath(new URL(`../node_modules/${p}`, import.meta.url));

const webPort = Number(process.env.GOBLIN_WEB_PORT ?? 5173);
const apiPort = Number(process.env.GOBLIN_API_PORT ?? 8787);
const appUrl = `http://127.0.0.1:${webPort}/`;
const healthUrl = `http://127.0.0.1:${webPort}/api/health`;
const wantsBrowser = process.argv.includes('--open');

// Double-clicking the start script a second time should bring up the app
// that is already running, not fail on a busy port with a wall of errors.
if (await answers(healthUrl, 800)) {
  say(`GoblinKit is already running at ${appUrl}`);
  if (wantsBrowser) openBrowser(appUrl);
  process.exit(0);
}

const env = {
  ...process.env,
  GOBLIN_PORT: String(apiPort),
  GOBLIN_API_PORT: String(apiPort),
  GOBLIN_WEB_PORT: String(webPort),
};

const procs = [
  ['api', [bin('tsx/dist/cli.mjs'), 'watch', '--clear-screen=false', 'apps/api/src/main.ts']],
  ['web', [bin('vite/bin/vite.js'), '--config', 'apps/web/vite.config.ts']],
].map(([name, args]) => {
  const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env });
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

say('GoblinKit is starting...');

// Ready means the page can load AND its first call to the API will succeed,
// so the browser never opens onto a "cannot reach the server" screen. The API
// is asked directly first: asking through the web server while the API is
// still starting makes Vite log an alarming (and harmless) proxy error.
const started = Date.now();
const ready = async () =>
  (await answers(`http://127.0.0.1:${apiPort}/api/health`, 1000)) && (await answers(healthUrl, 1000));
while (!stopping && !(await ready())) {
  if (Date.now() - started > 60_000) {
    say('GoblinKit did not come up within a minute. The lines above say why.');
    stopAll();
    break;
  }
  await new Promise((r) => setTimeout(r, 300));
}
if (!stopping) {
  say(`GoblinKit is ready: ${appUrl}`);
  say('Keep this window open while you use it. Close it, or press Ctrl+C, to stop GoblinKit.');
  if (wantsBrowser) openBrowser(appUrl);
}

/* ------------------------------------------------------------------ helpers */

async function answers(url, timeoutMs) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

function openBrowser(url) {
  if (process.env.GOBLIN_NO_BROWSER) {
    say(`(GOBLIN_NO_BROWSER is set, so not opening ${url})`);
    return;
  }
  // The platform's own "open this with the default app".
  const [command, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '""', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsVerbatimArguments: true });
  child.on('error', () => say(`Could not open a browser. Open ${url} yourself.`));
  child.unref();
}

function say(text) {
  process.stdout.write(`\n\x1b[1m${text}\x1b[0m\n`);
}
