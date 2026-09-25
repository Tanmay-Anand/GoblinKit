import { describe, expect, it } from 'vitest';

import { MapRegistry, migrateDocument, validateDocument, type WorkflowDocument } from '@goblin/spec';
import { compile } from '@goblin/graph';
import { coreManifests } from '@goblin/nodes-core';

const registry = new MapRegistry(coreManifests);

const base = (nodes: WorkflowDocument['nodes'], edges: WorkflowDocument['edges']): WorkflowDocument => ({
  schemaVersion: 1,
  id: 'wf',
  tenantId: 't',
  name: 'test',
  nodes,
  edges,
});

const node = (id: string, type: string, config: Record<string, unknown> = {}) => ({
  id,
  type,
  typeVersion: 1,
  config: config as WorkflowDocument['nodes'][number]['config'],
});

const edge = (id: string, from: string, fromPort: string, to: string, toPort = 'main') => ({
  id,
  from: { node: from, port: fromPort },
  to: { node: to, port: toPort },
});

const codes = (doc: WorkflowDocument) => validateDocument(doc, registry).map((d) => d.code);

describe('validateDocument', () => {
  it('accepts a wired-up workflow', () => {
    const doc = base(
      [node('t', 'core.trigger.manual'), node('l', 'core.log')],
      [edge('e1', 't', 'main', 'l')],
    );
    expect(validateDocument(doc, registry)).toEqual([]);
  });

  it('reports an unknown type and an unknown version differently', () => {
    const unknownType = base([node('a', 'core.nope')], []);
    expect(codes(unknownType)).toContain('UNKNOWN_NODE_TYPE');

    const unknownVersion = base([{ ...node('a', 'core.log'), typeVersion: 99 }], []);
    // A version that does not exist is a migration problem, not a typo, and
    // the message people get should reflect which one they have.
    expect(codes(unknownVersion)).toContain('UNKNOWN_TYPE_VERSION');
  });

  it('names the port that does not exist', () => {
    const doc = base(
      [node('t', 'core.trigger.manual'), node('l', 'core.log')],
      [edge('e1', 't', 'nope', 'l')],
    );
    const diagnostic = validateDocument(doc, registry).find((d) => d.code === 'PORT_MISMATCH');
    expect(diagnostic?.message).toContain('nope');
    expect(diagnostic?.path).toEqual(['edges', 0, 'from', 'port']);
  });

  it('refuses a workflow with nothing to start it', () => {
    expect(codes(base([node('l', 'core.log')], []))).toContain('NO_TRIGGER');
  });

  it('flags a missing required input', () => {
    const doc = base([node('t', 'core.trigger.manual'), node('l', 'core.log')], []);
    expect(codes(doc)).toContain('MISSING_REQUIRED_INPUT');
  });

  it('flags a required setting left empty, and points at the field', () => {
    const doc = base(
      [node('t', 'core.trigger.manual'), node('h', 'core.http.request', { url: '  ' })],
      [edge('e1', 't', 'main', 'h')],
    );
    const diagnostic = validateDocument(doc, registry).find((d) => d.code === 'INVALID_CONFIG');
    expect(diagnostic?.path).toEqual(['nodes', 1, 'config', 'url']);
    expect(diagnostic?.message).toMatch(/URL/);
  });

  it('counts a default as filled in', () => {
    // Wait's duration is required but defaults to 1000 ms: nothing to fix.
    const doc = base([node('t', 'core.trigger.manual'), node('w', 'core.wait')], [edge('e1', 't', 'main', 'w')]);
    expect(codes(doc)).not.toContain('INVALID_CONFIG');
  });

  it('warns about an unreachable node rather than rejecting it', () => {
    const doc = base(
      [node('t', 'core.trigger.manual'), node('a', 'core.log'), node('orphan', 'core.log')],
      [edge('e1', 't', 'main', 'a'), edge('e2', 'orphan', 'main', 'a')],
    );
    const unreachable = validateDocument(doc, registry).find((d) => d.code === 'UNREACHABLE');
    // A half-built branch is a normal state for a document someone is editing.
    // Refusing to save it would make the editor fight the person using it.
    expect(unreachable?.severity).toBe('warning');
  });

  it('catches a duplicate node id', () => {
    const doc = base([node('same', 'core.trigger.manual'), node('same', 'core.log')], []);
    expect(codes(doc)).toContain('DUPLICATE_ID');
  });
});

describe('cycle rules', () => {
  it('rejects a cycle that does not go through a scope', () => {
    const doc = base(
      [node('t', 'core.trigger.manual'), node('a', 'core.log'), node('b', 'core.log')],
      [edge('e1', 't', 'main', 'a'), edge('e2', 'a', 'main', 'b'), edge('e3', 'b', 'main', 'a')],
    );
    const diagnostics = compile(doc, registry).diagnostics;
    const cycle = diagnostics.find((d) => d.code === 'UNSCOPED_CYCLE');
    expect(cycle).toBeDefined();
    expect(cycle?.quickFix?.title).toMatch(/loop scope/i);
  });

  it('allows a cycle back into a scope start, and marks it as the loop edge', () => {
    const doc = base(
      [
        node('t', 'core.trigger.manual'),
        node('loop', 'core.scope.while', { condition: 'false' }),
        node('body', 'core.log'),
        node('end', 'core.scope.end'),
      ],
      [
        edge('e1', 't', 'main', 'loop'),
        edge('e2', 'loop', 'item', 'body'),
        edge('e3', 'body', 'main', 'end'),
        edge('e4', 'end', 'main', 'loop'),
      ],
    );
    const graph = compile(doc, registry);
    expect(graph.diagnostics.filter((d) => d.code === 'UNSCOPED_CYCLE')).toEqual([]);
    expect(graph.loopBackEdges.has('e4')).toBe(true);
  });

  it('works out which scope each node runs inside', () => {
    const doc = base(
      [
        node('t', 'core.trigger.manual'),
        node('each', 'core.scope.forEach'),
        node('body', 'core.log'),
        node('end', 'core.scope.end'),
        node('after', 'core.log'),
      ],
      [
        edge('e1', 't', 'main', 'each'),
        edge('e2', 'each', 'item', 'body'),
        edge('e3', 'body', 'main', 'end'),
        edge('e4', 'each', 'done', 'after'),
      ],
    );
    const graph = compile(doc, registry);
    expect(graph.nodes.get('body')?.scopeChain).toEqual(['each']);
    expect(graph.nodes.get('after')?.scopeChain).toEqual([]);
    expect(graph.scopeEnds.get('each')).toBe('end');
  });
});

describe('migrations', () => {
  it('stamps a document that arrived without a schema version', () => {
    const { document } = migrateDocument({ id: 'wf', tenantId: 't', name: 'x', nodes: [], edges: [] });
    expect(document.schemaVersion).toBe(1);
  });

  it('refuses a document from a newer build instead of silently dropping fields', () => {
    // Opening it read-only would be worse than refusing: the next save would
    // quietly discard whatever this build does not understand.
    expect(() => migrateDocument({ schemaVersion: 999, nodes: [], edges: [] })).toThrow(/Upgrade GoblinKit/);
  });
});
