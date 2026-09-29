import { CORE_CAPABILITIES, type CredentialTypeManifest, type NodeManifest } from './types.js';

/**
 * Rules on a manifest's own shape — the parts `spec` owns, so every
 * consumer (the contract suite, a registry loading a pack, a driver) checks
 * them the same way. Returns every problem, as sentences.
 */
export function validateManifest(m: NodeManifest): string[] {
  const problems: string[] = [];

  if (m.maxConcurrency !== undefined) {
    if (!Number.isInteger(m.maxConcurrency) || m.maxConcurrency < 1) problems.push('maxConcurrency must be a whole number from 1');
    // Concurrency is the number of items in flight, which only means
    // something when the box handles items one at a time (§6.4).
    if (m.executionMode !== 'perItem') problems.push('maxConcurrency applies only to perItem boxes');
  }

  const slots = m.credentials ?? [];
  const names = slots.map((s) => s.name);
  if (new Set(names).size !== names.length) problems.push('duplicate credential slot name');
  for (const slot of slots) {
    if (!slot.accepts.length) problems.push(`credential slot "${slot.name}" accepts nothing, so no credential could fill it`);
    for (const cap of slot.accepts) {
      const problem = capabilityProblem(cap);
      if (problem) problems.push(`credential slot "${slot.name}": ${problem}`);
    }
  }

  const actions = (m.actions ?? []).map((a) => a.id);
  if (new Set(actions).size !== actions.length) problems.push('duplicate action id');
  return problems;
}

/** The same for a credential type. */
export function validateCredentialType(m: CredentialTypeManifest): string[] {
  const problems: string[] = [];
  if (!/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/.test(m.type)) problems.push('type must be a dotted namespace like "pack.thing"');
  if (!Number.isInteger(m.version) || m.version < 1) problems.push('version must be a whole number from 1');
  if (!m.title.trim()) problems.push('needs a title — it is what the picker shows');
  if (!m.provides.length) problems.push('provides no capability, so no box could use it');
  for (const cap of m.provides) {
    const problem = capabilityProblem(cap);
    if (problem) problems.push(problem);
  }
  const names = m.fields.map((f) => f.name);
  if (new Set(names).size !== names.length) problems.push('duplicate field name');
  if (!m.fields.some((f) => f.secret)) problems.push('declares no secret field — if nothing is secret, it is config, not a credential');
  for (const f of m.fields) {
    if (f.type === 'select' && !f.options?.length) problems.push(`select field "${f.name}" has no options`);
  }
  return problems;
}

/**
 * Capabilities are contracts between packs, so their names are held to a
 * shape: versioned always, and namespaced unless the kit itself defines it.
 */
export function capabilityProblem(id: string): string | undefined {
  const match = /^([a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)*)@([1-9][0-9]*)$/.exec(id);
  if (!match) return `capability "${id}" must be a name and a version, like "httpAuth@1"`;
  const namespaced = match[1]!.includes('.');
  if (!namespaced && !(CORE_CAPABILITIES as readonly string[]).includes(id)) {
    return `capability "${id}" is not one the kit defines, so it must be namespaced, like "acme.session@1"`;
  }
  return undefined;
}
