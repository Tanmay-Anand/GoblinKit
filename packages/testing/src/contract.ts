import type { NodeDefinition } from '@goblin/node-sdk';
import type { NodeManifest } from '@goblin/spec';

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

    const hasExecutor = pack.nodes.some((n) => n.manifest.type === m.type && n.manifest.version === m.version);
    if (engine.has(m.type) && hasExecutor) say('is implemented by the engine and must not ship an executor');
    if (!engine.has(m.type) && !hasExecutor) say('has no executor, so running it would fail');
  }

  for (const n of pack.nodes) {
    const listed = pack.manifests.some((m) => m.type === n.manifest.type && m.version === n.manifest.version);
    if (!listed) problems.push(`${n.manifest.type}@${n.manifest.version}: has an executor but no manifest in the pack`);
  }
  return problems;
}
