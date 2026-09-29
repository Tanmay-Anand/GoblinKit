import type { JsonValue } from '@goblin/spec';

/** §11.1. The class decides the policy: retry, fail fast, or flag a credential. */
export type ErrorClass = 'transient' | 'rate_limited' | 'auth' | 'validation' | 'permanent' | 'cancelled';

export interface FailureOptions {
  code?: string;
  retryable?: boolean;
  errorClass?: ErrorClass;
}

export class NodeFailure extends Error {
  readonly code: string | undefined;
  readonly retryable: boolean;
  readonly errorClass: ErrorClass | undefined;

  constructor(message: string, options?: FailureOptions) {
    super(message);
    this.name = 'NodeFailure';
    this.code = options?.code;
    this.errorClass = options?.errorClass;
    // Retryable by default: most failures at this boundary are network or
    // rate-limit shaped, and a node author who knows better says so explicitly.
    // A class that says otherwise wins over the default.
    const failFast = options?.errorClass === 'auth' || options?.errorClass === 'validation' || options?.errorClass === 'permanent';
    this.retryable = options?.retryable ?? !failFast;
  }
}

/**
 * The class an HTTP status belongs to (§11.1), so every box that talks HTTP
 * retries the same things and gives up on the same things.
 */
export function classifyHttpStatus(status: number): { errorClass: ErrorClass; retryable: boolean } {
  if (status === 429) return { errorClass: 'rate_limited', retryable: true };
  if (status === 401 || status === 403) return { errorClass: 'auth', retryable: false };
  if (status === 408 || status >= 500) return { errorClass: 'transient', retryable: true };
  return { errorClass: 'validation', retryable: false };
}

/**
 * Replace every occurrence of a secret with a marker (§14.2).
 *
 * An exact-value scrub rather than a pattern over names like "password":
 * the secret is known, so it is removed wherever it turns up — a log line, an
 * error message, a header echoed back in a response body. Very short values
 * are left alone, because scrubbing "a" from every string is noise, not safety.
 */
export function redact<T extends JsonValue | string>(value: T, secrets: ReadonlySet<string> | readonly string[]): T {
  const list = [...secrets].filter((s) => s.length >= 4).sort((a, b) => b.length - a.length);
  if (!list.length) return value;
  const scrub = (text: string) => list.reduce((t, s) => t.split(s).join('[redacted]'), text);
  const walk = (v: JsonValue): JsonValue => {
    if (typeof v === 'string') return scrub(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, JsonValue> = {};
      for (const [k, inner] of Object.entries(v)) out[scrub(k)] = walk(inner);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}
