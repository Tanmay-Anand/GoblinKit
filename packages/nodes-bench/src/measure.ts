/**
 * Measuring one target: warm up, time N requests, summarise.
 *
 * Shared by `bench.http.measure` and by `bench.baseline`'s re-measurement,
 * so a suspected regression is checked by exactly the code that found it.
 */

import { fn, NodeFailure, type ErrorClass, type HttpMethod, type MeteredHttpClient, type ResolvedCredential } from '@goblin/node-sdk';
import type { JsonObject } from '@goblin/spec';

/** Everything needed to measure a target again, later, the same way. */
export interface TargetRequest {
  method: HttpMethod;
  url: string;
  /** The box's own headers — never a credential's; the client adds those. */
  headers: Record<string, string>;
  warmupRuns: number;
  runs: number;
  timeoutMs: number;
  expectStatus: string;
}

export interface Measurement {
  key: string;
  label: string;
  url: string;
  status: number;
  /** Decoded body size of the last timed run. */
  bytes: number;
  /** Total time of each timed run, in order. */
  runs: number[];
  minMs: number;
  medianMs: number;
  maxMs: number;
  ttfbMedianMs: number;
  /** Only with 20 or more runs: fewer cannot say anything about a tail. */
  p95Ms?: number;
  request: TargetRequest;
}

export interface TargetFailure {
  key: string;
  label: string;
  url: string;
  /** The status that was not expected, when there was an answer at all. */
  status?: number;
  class: ErrorClass;
  code: string;
  message: string;
}

export const P95_MIN_RUNS = 20;

const r2 = (n: number) => Math.round(n * 100) / 100;

export function statusAccepted(status: number, expect: string): boolean {
  if (expect === 'any') return true;
  if (expect === '2xx or 3xx') return status >= 200 && status < 400;
  return status >= 200 && status < 300;
}

/**
 * Measure one target. A failure of this target — a timeout, a 500, a 401 —
 * is returned, not thrown, so one bad endpoint never costs the others their
 * numbers. Cancellation is thrown: the whole box is stopping.
 */
export async function measureTarget(
  http: MeteredHttpClient,
  target: { key: string; label: string; request: TargetRequest },
  auth: ResolvedCredential | undefined,
  signal: AbortSignal,
): Promise<Measurement | TargetFailure> {
  const { request } = target;
  const totals: number[] = [];
  const ttfbs: number[] = [];
  let status = 0;
  let bytes = 0;
  const base = { key: target.key, label: target.label, url: request.url };

  for (let i = 0; i < request.warmupRuns + request.runs; i++) {
    try {
      const res = await http.request({
        method: request.method,
        url: request.url,
        headers: request.headers,
        signal,
        timeoutMs: request.timeoutMs,
        ...(auth ? { auth } : {}),
        // Measuring: a future rate limiter must not add its own queueing.
        bypassRateLimit: true,
      });
      status = res.status;
      if (!statusAccepted(res.status, request.expectStatus)) {
        const cls = res.status === 401 || res.status === 403 ? 'auth' : res.status === 429 ? 'rate_limited' : res.status >= 500 ? 'transient' : 'validation';
        return { ...base, status: res.status, class: cls, code: `HTTP_${res.status}`, message: `HTTP ${res.status} from ${hostOf(request.url)}` };
      }
      // Warm-up runs prime caches and connections; they are not timed.
      if (i < request.warmupRuns) continue;
      totals.push(res.timing.totalMs);
      ttfbs.push(res.timing.ttfbMs);
      bytes = res.bytes;
    } catch (error) {
      if (!(error instanceof NodeFailure)) throw error;
      if (error.errorClass === 'cancelled') throw error;
      return { ...base, class: error.errorClass ?? 'transient', code: error.code ?? 'NETWORK', message: error.message };
    }
  }

  return {
    ...base,
    status,
    bytes,
    runs: totals,
    minMs: r2(fn.min(totals) ?? 0),
    medianMs: r2(fn.median(totals) ?? 0),
    maxMs: r2(fn.max(totals) ?? 0),
    ttfbMedianMs: r2(fn.median(ttfbs) ?? 0),
    ...(totals.length >= P95_MIN_RUNS ? { p95Ms: r2(fn.percentile(totals, 95) ?? 0) } : {}),
    request,
  };
}

export const isFailure = (m: Measurement | TargetFailure): m is TargetFailure => 'class' in m;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * The measurements carried by some items: a measurement itself, or a
 * comparison (which carries the two it compared). Later ones win per target.
 */
export function measurementsIn(items: readonly { data: unknown }[]): Measurement[] {
  const byTarget = new Map<string, Measurement>();
  const add = (m: unknown) => {
    if (!m || typeof m !== 'object') return;
    const x = m as Partial<Measurement>;
    if (typeof x.key !== 'string' || typeof x.label !== 'string' || typeof x.medianMs !== 'number') return;
    byTarget.set(`${x.key}\u0000${x.label}`, x as Measurement);
  };
  for (const item of items) {
    const data = item.data as JsonObject | null;
    if (data && Array.isArray(data['measurements'])) for (const m of data['measurements']) add(m);
    else add(data);
  }
  return [...byTarget.values()];
}
