import { describe, expect, it } from 'vitest';

import {
  CredentialAuthError,
  CredentialRuntime,
  defineCapability,
  defineCredentialResolver,
  defineCredentialType,
  InMemoryCredentialStore,
  MockHttp,
  NodeFailure,
  type CredentialTypeDefinition,
} from '@goblin/node-sdk';

const tokenType = defineCredentialType({
  type: 'test.token',
  version: 1,
  title: 'Test token',
  provides: ['httpAuth@1'],
  fields: [{ name: 'refresh', secret: true, required: true }],
});

/** A resolver that mints a token per call and counts them, like a real refresh. */
function minting(options: { ttlMs?: number; delayMs?: number; fail?: () => Error | undefined } = {}) {
  let minted = 0;
  const definition = defineCredentialResolver(tokenType, async (values) => {
    if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
    const error = options.fail?.();
    if (error) throw error;
    minted++;
    const token = `token-${minted}-for-${values['refresh']}`;
    return { value: { headers: { authorization: `Bearer ${token}` } }, expiresAt: now + (options.ttlMs ?? 3_600_000), secrets: [token] };
  });
  return { definition, minted: () => minted };
}

let now = 1_700_000_000_000;

function setup(types: CredentialTypeDefinition[]) {
  const store = new InMemoryCredentialStore();
  const runtime = new CredentialRuntime({ store, types, http: new MockHttp().client(), now: () => now });
  return { store, runtime };
}

const accepts = { accepts: ['httpAuth@1'], signal: new AbortController().signal };

async function failure(promise: Promise<unknown>): Promise<NodeFailure> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof NodeFailure) return error;
    throw error;
  }
  throw new Error('expected a failure');
}

describe('the credential runtime', () => {
  it('caches a resolved value until shortly before it expires', async () => {
    const mint = minting({ ttlMs: 10 * 60_000 });
    const { store, runtime } = setup([mint.definition]);
    const cred = await store.create({ type: 'test.token', name: 'dev', values: { refresh: 'r1' } });

    const first = await runtime.resolve({ id: cred.id, type: 'test.token' }, accepts);
    await runtime.resolve({ id: cred.id, type: 'test.token' }, accepts);
    expect(mint.minted()).toBe(1);
    expect(first.capability).toBe('httpAuth@1');
    expect(first.secrets).toContain('token-1-for-r1');
    expect(first.secrets).toContain('r1');

    now += 9.5 * 60_000; // within the 60 s refresh margin
    await runtime.resolve({ id: cred.id, type: 'test.token' }, accepts);
    expect(mint.minted()).toBe(2);
  });

  it('refreshes once when many boxes ask at the same moment (single-flight)', async () => {
    const mint = minting({ delayMs: 20 });
    const { store, runtime } = setup([mint.definition]);
    const cred = await store.create({ type: 'test.token', name: 'dev', values: { refresh: 'r1' } });
    const all = await Promise.all(Array.from({ length: 10 }, () => runtime.resolve({ id: cred.id, type: 'test.token' }, accepts)));
    expect(mint.minted()).toBe(1);
    expect(new Set(all.map((r) => JSON.stringify(r.value))).size).toBe(1);
  });

  it('forgets the cached token the moment the credential is replaced', async () => {
    const mint = minting();
    const { store, runtime } = setup([mint.definition]);
    const cred = await store.create({ type: 'test.token', name: 'dev', values: { refresh: 'old' } });
    await runtime.resolve({ id: cred.id, type: 'test.token' }, accepts);
    await store.replace(cred.id, { values: { refresh: 'new' } });
    // Even without an explicit invalidate: the cache is keyed on the record's revision.
    const after = await runtime.resolve({ id: cred.id, type: 'test.token' }, accepts);
    expect(JSON.stringify(after.value)).toContain('for-new');
  });

  it('marks a credential "needs sign-in" when the provider refuses it, and stops asking', async () => {
    let refuse = true;
    const mint = minting({ fail: () => (refuse ? new CredentialAuthError('Refresh Token has been revoked') : undefined) });
    const { store, runtime } = setup([mint.definition]);
    const cred = await store.create({ type: 'test.token', name: 'dev', values: { refresh: 'r1' } });

    const error = await failure(runtime.resolve({ id: cred.id, type: 'test.token' }, accepts));
    expect(error.code).toBe('NEEDS_REAUTH');
    expect(error.errorClass).toBe('auth');
    expect(error.retryable).toBe(false);
    expect(error.message).toMatch(/“dev” needs signing in again \(Refresh Token has been revoked\)/);
    expect((await store.get(cred.id))?.status).toBe('needs_reauth');

    // Fails fast from now on, without calling the provider again.
    refuse = false;
    expect((await failure(runtime.resolve({ id: cred.id, type: 'test.token' }, accepts))).code).toBe('NEEDS_REAUTH');
    expect(mint.minted()).toBe(0);

    // New values are a fresh start.
    await store.replace(cred.id, { values: { refresh: 'r2' } });
    await runtime.resolve({ id: cred.id, type: 'test.token' }, accepts);
    expect(mint.minted()).toBe(1);
  });

  it('explains a deleted credential, and one a box cannot use', async () => {
    const mint = minting();
    const { store, runtime } = setup([mint.definition]);
    expect((await failure(runtime.resolve({ id: 'cred_gone', type: 'test.token' }, accepts))).code).toBe('CREDENTIAL_MISSING');
    const cred = await store.create({ type: 'test.token', name: 'dev', values: { refresh: 'r' } });
    const wrong = await failure(runtime.resolve({ id: cred.id, type: 'test.token' }, { ...accepts, accepts: ['httpSigner@1'] }));
    expect(wrong.code).toBe('CREDENTIAL_WRONG_TYPE');
  });

  it('refuses a resolver whose value does not fit the capability it promises', async () => {
    const broken = defineCredentialResolver(tokenType, () => ({ value: { header: 'oops' } }));
    const { store, runtime } = setup([broken]);
    const cred = await store.create({ type: 'test.token', name: 'dev', values: { refresh: 'r' } });
    const error = await failure(runtime.resolve({ id: cred.id, type: 'test.token' }, accepts));
    expect(error.code).toBe('CREDENTIAL_BAD_OUTPUT');
    expect(error.message).toMatch(/httpAuth@1 must be \{ headers/);
  });
});

describe('capabilities', () => {
  it('must be versioned, and namespaced unless the kit defines them', () => {
    expect(() => defineCapability({ id: 'session', description: '', check: () => [] })).toThrow(/name and a version/);
    expect(() => defineCapability({ id: 'session@1', description: '', check: () => [] })).toThrow(/must be namespaced/);
    expect(defineCapability({ id: 'acme.session@1', description: '', check: () => [] }).id).toBe('acme.session@1');
  });
});
