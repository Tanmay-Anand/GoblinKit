/**
 * `ctx.http` — the one way a box talks HTTP (§12.2, §14.4).
 *
 * Boxes do not call `fetch`. They call this, and it does the things every
 * box would otherwise have to remember: an abort signal and a timeout that
 * always reach the request, a response-size cap, the egress rule, applying a
 * credential without the box ever handling its headers, and timing — when
 * the first byte arrived and when the last one did, which is what the
 * endpoint-latency pack measures and what every trace wants.
 *
 * What it deliberately does not do: retry. Retries are the engine's policy
 * (§11.2), set per box and visible in the journal; a client that retried
 * underneath would make a box's attempts invisible and its timings wrong.
 */

import type { JsonValue } from '@goblin/spec';

import { NodeFailure } from './failure.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

/** A request as a signer sees it: final URL, headers and body bytes. */
export interface HttpRequestDraft {
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  /** Already serialised: a signature covers the exact bytes sent. */
  body?: string | Uint8Array;
}

/** What a resolved credential gives the client (§A2). The client applies it; the box never looks inside. */
export type ResolvedHttpCredential =
  | { capability: 'httpAuth@1'; value: { headers: Record<string, string> } }
  | { capability: 'httpSigner@1'; value: { sign(request: HttpRequestDraft): HttpRequestDraft | Promise<HttpRequestDraft> } };

export interface HttpRequest {
  method: HttpMethod;
  url: string;
  headers?: Record<string, string>;
  /** An object is sent as JSON; a string or bytes as they are. */
  body?: JsonValue | Uint8Array;
  signal: AbortSignal;
  timeoutMs: number;
  /** Fail, never truncate, past this many decoded bytes. Default 10 MB. */
  maxResponseBytes?: number;
  auth?: ResolvedHttpCredential | { capability: string; value: unknown };
  /**
   * Reserved for Stage 8's per-tenant rate limits: a measuring box sets it so
   * the limiter does not add its own queueing to the latency it records.
   * Has no effect until a limiter exists (ADR-017).
   */
  bypassRateLimit?: boolean;
}

export interface HttpResponse {
  status: number;
  ok: boolean;
  /** Lower-cased names. */
  headers: Record<string, string>;
  body: Uint8Array;
  text(): string;
  json<T = JsonValue>(): T;
  /** The decoded body's length: what arrived after any gzip was undone. */
  bytes: number;
  timing: {
    /** Request sent → response headers received. */
    ttfbMs: number;
    /** Request sent → last body byte read. */
    totalMs: number;
  };
}

export interface MeteredHttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
}

/** The part of `fetch` the client uses. Tests hand in a mock (see harness.ts). */
export type HttpTransport = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string | Uint8Array; signal: AbortSignal },
) => Promise<Response>;

export interface HttpClientOptions {
  transport?: HttpTransport;
  /** Monotonic milliseconds. `performance.now()` unless a test pins it. */
  now?: () => number;
  /**
   * 'local': one person on their own machine — loopback addresses are
   * allowed, because calling your own dev server is the point. 'hosted':
   * they are refused. DNS-time checks arrive with Stage 8 (§14.4).
   */
  mode?: 'local' | 'hosted';
  defaultMaxResponseBytes?: number;
}

export const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
/** No box may raise its cap past this. */
export const PLATFORM_MAX_RESPONSE_BYTES = 100 * 1024 * 1024;

export function createHttpClient(options: HttpClientOptions = {}): MeteredHttpClient {
  const transport: HttpTransport = options.transport ?? ((url, init) => fetch(url, init as RequestInit));
  const now = options.now ?? (() => performance.now());
  const mode = options.mode ?? 'local';

  return {
    async request(req: HttpRequest): Promise<HttpResponse> {
      let parsed: URL;
      try {
        parsed = new URL(req.url);
      } catch {
        throw new NodeFailure(`"${req.url}" is not a valid address.`, { code: 'BAD_URL', errorClass: 'validation' });
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new NodeFailure(`Only http and https addresses can be called, not ${parsed.protocol}`, { code: 'BAD_URL', errorClass: 'validation' });
      }
      checkEgress(parsed, mode);

      const cap = Math.min(req.maxResponseBytes ?? options.defaultMaxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES, PLATFORM_MAX_RESPONSE_BYTES);
      const headers = { ...(req.headers ?? {}) };
      let draft = await applyAuth({ method: req.method, url: parsed.toString(), headers, ...serialise(req.body, headers) }, req.auth);
      if (req.method === 'GET' || req.method === 'HEAD') draft = withoutBody(draft);

      // The box's signal and the timeout both reach the request — and the
      // body read, so a response that trickles in forever is cut off too.
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, req.timeoutMs);
      const onAbort = () => controller.abort();
      if (req.signal.aborted) controller.abort();
      else req.signal.addEventListener('abort', onAbort, { once: true });

      const host = parsed.host;
      const started = now();
      try {
        let res: Response;
        try {
          res = await transport(draft.url, {
            method: draft.method,
            headers: draft.headers,
            ...(draft.body !== undefined ? { body: draft.body } : {}),
            signal: controller.signal,
          });
        } catch (error) {
          throw networkFailure(error, host, req.timeoutMs, timedOut, req.signal.aborted);
        }
        const ttfbMs = now() - started;

        let body: Uint8Array;
        try {
          body = await readCapped(res, cap, host);
        } catch (error) {
          if (error instanceof NodeFailure) throw error;
          throw networkFailure(error, host, req.timeoutMs, timedOut, req.signal.aborted);
        }
        const totalMs = now() - started;

        const headers: Record<string, string> = {};
        res.headers.forEach((value, name) => {
          headers[name.toLowerCase()] = value;
        });
        let decoded: string | undefined;
        const text = () => (decoded ??= new TextDecoder().decode(body));
        return {
          status: res.status,
          ok: res.ok,
          headers,
          body,
          text,
          json: <T = JsonValue>() => JSON.parse(text()) as T,
          bytes: body.byteLength,
          timing: { ttfbMs: round(ttfbMs), totalMs: round(totalMs) },
        };
      } finally {
        clearTimeout(timer);
        req.signal.removeEventListener('abort', onAbort);
      }
    },
  };
}

const round = (ms: number) => Math.round(ms * 100) / 100;

/** Serialise the body; a JSON body gets a JSON content type unless one was set. */
function serialise(body: HttpRequest['body'], headers: Record<string, string>): { body?: string | Uint8Array } {
  if (body === undefined || body === null) return {};
  if (body instanceof Uint8Array || typeof body === 'string') return { body };
  if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
  return { body: JSON.stringify(body) };
}

function withoutBody(draft: HttpRequestDraft): HttpRequestDraft {
  const { body: _dropped, ...rest } = draft;
  return rest;
}

/**
 * The credential is applied here, after the box built its request, so a box
 * never holds a token in a variable it could log or emit. A header value
 * from the credential wins over the box's own header of the same name.
 */
async function applyAuth(draft: HttpRequestDraft, auth: HttpRequest['auth']): Promise<HttpRequestDraft> {
  if (!auth) return draft;
  if (auth.capability === 'httpAuth@1') {
    const extra = (auth.value as { headers: Record<string, string> }).headers;
    const headers = Object.fromEntries(
      Object.entries(draft.headers).filter(([name]) => !Object.keys(extra).some((e) => e.toLowerCase() === name.toLowerCase())),
    );
    return { ...draft, headers: { ...headers, ...extra } };
  }
  if (auth.capability === 'httpSigner@1') {
    return (auth.value as { sign(r: HttpRequestDraft): HttpRequestDraft | Promise<HttpRequestDraft> }).sign(draft);
  }
  throw new NodeFailure(`This box cannot use a credential of kind ${auth.capability} for an HTTP call.`, {
    code: 'CREDENTIAL_WRONG_TYPE',
    errorClass: 'validation',
  });
}

/** Read the body, failing — never truncating — once it passes the cap. */
async function readCapped(res: Response, cap: number, host: string): Promise<Uint8Array> {
  const tooLarge = () =>
    new NodeFailure(`${host} sent more than ${formatBytes(cap)}. Raise the box's response limit, or ask for less.`, {
      code: 'RESPONSE_TOO_LARGE',
      errorClass: 'validation',
    });
  const declared = Number(res.headers.get('content-length'));
  // Only trusted when there is no content-encoding: a gzip body's length is
  // the compressed size, and the cap is on what it decodes to.
  if (!res.headers.get('content-encoding') && Number.isFinite(declared) && declared > cap) {
    await res.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!res.body) return new Uint8Array(await res.arrayBuffer());

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1)$/i;
const LINK_LOCAL = /^169\.254\.\d{1,3}\.\d{1,3}$/;

function checkEgress(url: URL, mode: 'local' | 'hosted'): void {
  const host = url.hostname.toLowerCase();
  if (mode === 'hosted' && (LOOPBACK.test(host) || host.endsWith('.localhost'))) {
    throw new NodeFailure(`Calls to ${url.host} are not allowed here: it is this server itself.`, { code: 'EGRESS_BLOCKED', errorClass: 'validation' });
  }
  // The cloud metadata address is never a legitimate target, in any mode.
  if (LINK_LOCAL.test(host)) {
    throw new NodeFailure(`Calls to ${url.host} are not allowed: link-local addresses are blocked.`, { code: 'EGRESS_BLOCKED', errorClass: 'validation' });
  }
}

/**
 * Say why a request never got an answer.
 *
 * Node's fetch reports every network problem as "fetch failed" and hides the
 * reason in `cause`. That sentence is useless on a box marked red, so the
 * common causes are named, with the host, in words a person can act on.
 */
export function networkFailure(error: unknown, host: string, timeoutMs: number, timedOut: boolean, cancelled = false): NodeFailure {
  if (timedOut) return new NodeFailure(`${host} did not answer within ${timeoutMs / 1000} s.`, { code: 'TIMEOUT', errorClass: 'transient' });
  if (cancelled) return new NodeFailure(`The request to ${host} was cancelled.`, { code: 'CANCELLED', errorClass: 'cancelled', retryable: false });

  const reason = (error as { cause?: { code?: string; message?: string } } | null)?.cause;
  // fetch refuses a short list of ports outright (SMTP, IRC, …) for safety.
  if (reason?.message === 'bad port') {
    return new NodeFailure(`${host} uses a port that web requests are not allowed to use. Pick another port.`, {
      code: 'BAD_PORT',
      errorClass: 'validation',
    });
  }
  const cause = reason?.code;
  switch (cause) {
    case 'ECONNREFUSED':
      return new NodeFailure(`Could not connect to ${host}: nothing is listening there.`, { code: cause, errorClass: 'transient' });
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return new NodeFailure(`No such host: ${host}. Check the address.`, {
        code: cause,
        errorClass: cause === 'EAI_AGAIN' ? 'transient' : 'validation',
      });
    case 'ECONNRESET':
    case 'UND_ERR_SOCKET':
      return new NodeFailure(`${host} closed the connection before answering.`, { code: cause, errorClass: 'transient' });
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
      return new NodeFailure(`Could not reach ${host} in time.`, { code: cause, errorClass: 'transient' });
    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
      return new NodeFailure(`${host} has a certificate this machine does not trust.`, { code: cause, errorClass: 'validation' });
    default:
      return new NodeFailure(`The request to ${host} failed: ${error instanceof Error ? error.message : String(error)}.`, {
        code: cause ?? 'NETWORK',
        errorClass: 'transient',
      });
  }
}

function formatBytes(n: number): string {
  return n >= 1024 * 1024 ? `${Math.round((n / 1024 / 1024) * 10) / 10} MB` : `${Math.round(n / 1024)} KB`;
}
