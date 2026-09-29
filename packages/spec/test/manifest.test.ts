import { describe, expect, it } from 'vitest';

import {
  capabilityProblem,
  MapRegistry,
  migrateNodes,
  validateCredentialType,
  validateDocument,
  validateManifest,
  type NodeManifest,
  type WorkflowDocument,
} from '@goblin/spec';

const perItem: NodeManifest = {
  type: 'pack.measure',
  version: 1,
  title: 'Measure',
  group: 'data',
  executionMode: 'perItem',
  ports: { inputs: [{ id: 'main' }], outputs: [{ id: 'main' }] },
};

describe('manifest rules', () => {
  it('maxConcurrency is a whole number from 1, and only for perItem boxes', () => {
    expect(validateManifest({ ...perItem, maxConcurrency: 1 })).toEqual([]);
    expect(validateManifest({ ...perItem, maxConcurrency: 0 })).toContain('maxConcurrency must be a whole number from 1');
    expect(validateManifest({ ...perItem, maxConcurrency: 1.5 })).toContain('maxConcurrency must be a whole number from 1');
    expect(validateManifest({ ...perItem, executionMode: 'batch', maxConcurrency: 1 })).toContain('maxConcurrency applies only to perItem boxes');
  });

  it('credential slots must accept versioned capabilities', () => {
    const problems = validateManifest({ ...perItem, credentials: [{ name: 'auth', accepts: ['httpAuth'] }, { name: 'auth', accepts: [] }] });
    expect(problems.join('\n')).toMatch(/must be a name and a version/);
    expect(problems.join('\n')).toMatch(/duplicate credential slot/);
    expect(problems.join('\n')).toMatch(/accepts nothing/);
  });

  it('capabilities are versioned, and namespaced unless the kit defines them', () => {
    expect(capabilityProblem('httpAuth@1')).toBeUndefined();
    expect(capabilityProblem('aws.sigv4@1')).toBeUndefined();
    expect(capabilityProblem('sigv4@1')).toMatch(/must be namespaced/);
    expect(capabilityProblem('aws.sigv4')).toMatch(/name and a version/);
  });

  it('a credential type declares its secrets and what it provides', () => {
    const problems = validateCredentialType({ type: 'x', version: 1, title: 'X', provides: [], fields: [{ name: 'a' }] });
    expect(problems.join('\n')).toMatch(/dotted namespace/);
    expect(problems.join('\n')).toMatch(/provides no capability/);
    expect(problems.join('\n')).toMatch(/declares no secret field/);
  });
});

describe('credentials on a box', () => {
  const registry = new MapRegistry([
    { type: 'core.trigger.manual', version: 1, title: 'Start', group: 'trigger', executionMode: 'batch', trigger: true, ports: { inputs: [], outputs: [{ id: 'main' }] } },
    { ...perItem, credentials: [{ name: 'auth', label: 'Sign in with', accepts: ['httpAuth@1'], required: true }] },
  ]);
  const doc = (credentials?: Record<string, { id: string; type: string }>): WorkflowDocument => ({
    schemaVersion: 1,
    id: 'wf',
    tenantId: 'local',
    name: 'x',
    nodes: [
      { id: 't', type: 'core.trigger.manual', typeVersion: 1, config: {} },
      { id: 'm', type: 'pack.measure', typeVersion: 1, label: 'Measure', config: {}, ...(credentials ? { credentials } : {}) },
    ],
    edges: [{ id: 'e', from: { node: 't', port: 'main' }, to: { node: 'm', port: 'main' } }],
  });

  it('marks a required slot left empty, on the box', () => {
    const missing = validateDocument(doc(), registry).find((d) => d.code === 'MISSING_CREDENTIAL');
    expect(missing).toMatchObject({ severity: 'error', path: ['nodes', 1, 'credentials', 'auth'], message: 'Measure needs a credential picked for Sign in with.' });
    expect(validateDocument(doc({ auth: { id: 'cred_1', type: 'http.bearerToken' } }), registry)).toEqual([]);
  });
});

describe('box type migrations', () => {
  const document: WorkflowDocument = {
    schemaVersion: 1,
    id: 'wf',
    tenantId: 'local',
    name: 'x',
    nodes: [
      { id: 'h', type: 'core.http.request', typeVersion: 1, config: { url: 'https://x.test' } },
      { id: 'l', type: 'core.log', typeVersion: 1, config: {} },
    ],
    edges: [],
  };

  it('upgrades each box along its chain, and leaves the rest alone', () => {
    const { document: out, applied } = migrateNodes(document, [
      { type: 'core.http.request', from: 1, to: 2, up: (c) => ({ ...c, timeoutMs: 30_000 }) },
      { type: 'core.http.request', from: 2, to: 3, up: (c) => ({ ...c, v3: true }) },
    ]);
    expect(out.nodes[0]).toMatchObject({ typeVersion: 3, config: { url: 'https://x.test', timeoutMs: 30_000, v3: true } });
    expect(out.nodes[1]).toBe(document.nodes[1]);
    expect(applied).toEqual(['h: core.http.request 1 → 3']);
    // Pure: the input document is untouched.
    expect(document.nodes[0]!.typeVersion).toBe(1);
  });
});
