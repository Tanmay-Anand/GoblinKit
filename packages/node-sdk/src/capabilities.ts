/**
 * Capabilities: what a resolved credential can do, as a versioned contract.
 *
 * A box never asks for "a Cognito credential" — it asks for something that
 * provides `httpAuth@1`, and any credential type that provides it will do.
 * That is what lets a pack add a new way to sign in without touching a single
 * box, and why the contract has to be exact: each capability has a checker,
 * and the contract suite runs every resolver's output through it.
 *
 * The kit defines two. A pack may define more, namespaced (`aws.sigv4@1`),
 * so two packs can never mean different things by one name.
 */

import { capabilityProblem } from '@goblin/spec';

export interface Capability {
  /** Versioned, and namespaced unless it is one of the kit's own. */
  id: string;
  description: string;
  /** Problems with a resolved value, as sentences; empty when it conforms. */
  check(value: unknown): string[];
}

export function defineCapability(capability: Capability): Capability {
  const problem = capabilityProblem(capability.id);
  if (problem) throw new Error(problem);
  return capability;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** `{ headers }` merged into the request. Bearer tokens, API-key headers, basic auth. */
export const httpAuth = defineCapability({
  id: 'httpAuth@1',
  description: 'Headers added to every request: { headers: Record<string, string> }.',
  check(value) {
    if (!isRecord(value) || !isRecord(value['headers'])) return ['must be { headers: { name: value } }'];
    const bad = Object.entries(value['headers']).filter(([, v]) => typeof v !== 'string').map(([k]) => k);
    return bad.length ? [`header values must be strings (${bad.join(', ')})`] : [];
  },
});

/**
 * `{ sign(request) }` rewrites the finished request: for schemes that sign
 * the whole thing (AWS SigV4) or put the key in the query string.
 */
export const httpSigner = defineCapability({
  id: 'httpSigner@1',
  description: 'Rewrites the finished request: { sign(request) → request }.',
  check(value) {
    return isRecord(value) && typeof value['sign'] === 'function' ? [] : ['must be { sign(request) }'];
  },
});

export const coreCapabilities: Capability[] = [httpAuth, httpSigner];
