import {
  checkResolved,
  coreCapabilities,
  createHttpClient,
  type Capability,
  type CredentialTypeDefinition,
  type MeteredHttpClient,
  type NodeDefinition,
} from '@goblin/node-sdk';
import { validateCredentialType, validateManifest, type JsonValue, type NodeManifest } from '@goblin/spec';

export interface NodePackInput {
  manifests: NodeManifest[];
  nodes: NodeDefinition[];
  /** Types the scheduler implements itself, and which must therefore have no executor. */
  engineImplemented?: string[];
}

/**
 * The rules every node pack must satisfy. Returns every violation found.
 *
 * A list rather than a throw on the first problem, so a pack author sees
 * everything wrong in one run. Each rule exists because breaking it breaks
 * something concrete: the canvas cannot draw the box, the settings panel
 * cannot build its form, or the engine cannot schedule it.
 */
export function checkNodePack(pack: NodePackInput): string[] {
  const problems: string[] = [];
  const engine = new Set(pack.engineImplemented ?? []);
  const seen = new Set<string>();

  for (const m of pack.manifests) {
    const id = `${m.type}@${m.version}`;
    const say = (rule: string) => problems.push(`${id}: ${rule}`);

    if (seen.has(id)) say('declared twice');
    seen.add(id);

    // Dotted namespace, camelCase segments allowed: "core.scope.forEach".
    if (!/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/.test(m.type)) say('type must be a dotted namespace like "pack.thing"');
    if (!Number.isInteger(m.version) || m.version < 1) say('version must be a whole number from 1');
    if (!m.title.trim()) say('needs a title — it is the label on the canvas');

    // Inputs and outputs are separate namespaces, so each is checked alone.
    for (const [side, list] of [['input', m.ports.inputs], ['output', m.ports.outputs]] as const) {
      const ids = list.map((p) => p.id);
      if (new Set(ids).size !== ids.length) say(`duplicate ${side} port id`);
    }

    if (m.trigger && m.ports.inputs.length > 0) say('a trigger takes no input');
    if (!m.trigger && m.ports.inputs.length === 0) say('has no inputs and is not a trigger, so it could never run');

    const fields = m.config?.fields ?? [];
    const names = fields.map((f) => f.name);
    if (new Set(names).size !== names.length) say('duplicate config field name');
    for (const f of fields) {
      if (f.type === 'select' && !(f.options && f.options.length > 0)) say(`select field "${f.name}" has no options`);
      if (f.type === 'select' && f.default !== undefined && !f.options?.includes(String(f.default))) {
        say(`select field "${f.name}" defaults to a value it does not offer`);
      }
    }

    // A manifest is served to the browser as JSON, so it must survive the trip.
    try {
      if (JSON.stringify(JSON.parse(JSON.stringify(m))) !== JSON.stringify(m)) say('is not plain JSON data');
    } catch {
      say('is not plain JSON data');
    }

    for (const problem of validateManifest(m)) say(problem);
    const actionHandlers = pack.nodes.find((n) => n.manifest.type === m.type && n.manifest.version === m.version)?.actions ?? {};
    for (const action of m.actions ?? []) {
      if (!actionHandlers[action.id]) say(`action "${action.id}" has no handler`);
    }

    const hasExecutor = pack.nodes.some((n) => n.manifest.type === m.type && n.manifest.version === m.version);
    if (engine.has(m.type) && hasExecutor) say('is implemented by the engine and must not ship an executor');
    if (!engine.has(m.type) && !hasExecutor) say('has no executor, so running it would fail');
  }

  for (const n of pack.nodes) {
    const listed = pack.manifests.some((m) => m.type === n.manifest.type && m.version === n.manifest.version);
    if (!listed) problems.push(`${n.manifest.type}@${n.manifest.version}: has an executor but no manifest in the pack`);
  }

  // Migrations are total: the newest version of a type can upgrade a box
  // saved with any older one, or that box can never be opened as current.
  const versions = new Map<string, number[]>();
  for (const m of pack.manifests) versions.set(m.type, [...(versions.get(m.type) ?? []), m.version]);
  for (const [type, list] of versions) {
    const newest = Math.max(...list);
    const latest = pack.nodes.find((n) => n.manifest.type === type && n.manifest.version === newest);
    for (const v of list) {
      if (v === newest || !latest) continue;
      if (!latest.migrateFrom?.[v]) problems.push(`${type}@${newest}: has no migration from version ${v}`);
    }
  }
  return problems;
}

export interface CredentialPackInput {
  types: CredentialTypeDefinition[];
  /** Pack-defined capabilities, alongside the kit's. */
  capabilities?: Capability[];
  /** Sample values per type, to run each resolver once and check what it returns. */
  samples?: Record<string, Record<string, string>>;
  /** For resolvers that call a token endpoint: usually a MockHttp client. */
  http?: MeteredHttpClient;
}

/**
 * The rules every credential type must satisfy: its manifest is well formed,
 * it declares its secrets, its capabilities are versioned and namespaced and
 * registered, and — given sample values — its resolver returns what those
 * capabilities promise. A resolver that returns the wrong shape would fail
 * inside someone else's box, far from the pack that caused it.
 */
export async function checkCredentialPack(pack: CredentialPackInput): Promise<string[]> {
  const problems: string[] = [];
  const capabilities = new Map([...coreCapabilities, ...(pack.capabilities ?? [])].map((c) => [c.id, c]));
  const seen = new Set<string>();
  for (const { manifest, resolve } of pack.types) {
    const id = `${manifest.type}@${manifest.version}`;
    if (seen.has(id)) problems.push(`${id}: declared twice`);
    seen.add(id);
    for (const p of validateCredentialType(manifest)) problems.push(`${id}: ${p}`);
    for (const cap of manifest.provides) if (!capabilities.has(cap)) problems.push(`${id}: provides ${cap}, which is not registered`);
    try {
      if (JSON.stringify(JSON.parse(JSON.stringify(manifest))) !== JSON.stringify(manifest)) problems.push(`${id}: is not plain JSON data`);
    } catch {
      problems.push(`${id}: is not plain JSON data`);
    }

    const sample = pack.samples?.[manifest.type];
    if (!sample) continue;
    try {
      const resolved = await resolve(sample, {
        http: pack.http ?? createHttpClient(),
        signal: new AbortController().signal,
        logger: { info: () => {}, warn: () => {} },
        now: Date.now,
      });
      for (const p of checkResolved(manifest.provides, resolved.value, capabilities)) problems.push(`${id}: resolver output: ${p}`);
    } catch (error) {
      problems.push(`${id}: resolver failed on the sample: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return problems;
}

/**
 * Where any of these secrets appears in a value — emitted items, log lines,
 * an error. The contract a box that uses credentials must keep (§14.2).
 */
export function findSecrets(value: JsonValue | unknown, secrets: readonly string[]): string[] {
  const text = JSON.stringify(value) ?? '';
  return secrets.filter((s) => s.length >= 4 && text.includes(s));
}
