import { fieldApplies } from './types.js';
import type {
  Diagnostic,
  NodeManifest,
  NodeTypeId,
  WorkflowDocument,
} from './types.js';

/**
 * A registry is whatever can answer "what is this node type?".
 *
 * An interface rather than a concrete class, because validation runs in three
 * places — the editor, the API, and run start — and only one of them has the
 * executors loaded. Validation needs the manifest and nothing else.
 */
export interface ManifestRegistry {
  get(type: NodeTypeId, version: number): NodeManifest | undefined;
  /** Every version known for a type, for a better message than "unknown". */
  versions(type: NodeTypeId): number[];
}

export class MapRegistry implements ManifestRegistry {
  private readonly byKey = new Map<string, NodeManifest>();

  constructor(manifests: NodeManifest[] = []) {
    for (const m of manifests) this.add(m);
  }

  add(manifest: NodeManifest): this {
    this.byKey.set(`${manifest.type}@${manifest.version}`, manifest);
    return this;
  }

  get(type: NodeTypeId, version: number): NodeManifest | undefined {
    return this.byKey.get(`${type}@${version}`);
  }

  versions(type: NodeTypeId): number[] {
    const out: number[] = [];
    for (const key of this.byKey.keys()) {
      const [t, v] = key.split('@');
      if (t === type && v) out.push(Number(v));
    }
    return out.sort((a, b) => a - b);
  }

  all(): NodeManifest[] {
    return [...this.byKey.values()];
  }
}

/**
 * validateDocument returns diagnostics; it never throws.
 *
 * One implementation, three call sites: inline squiggles in the editor, a
 * rejected save in the API, and a precise failure at run start. Divergence
 * between client and server validation is how invalid documents reach
 * production, so there is exactly one copy of these rules.
 */
export function validateDocument(
  doc: WorkflowDocument,
  registry: ManifestRegistry,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const nodeById = new Map<string, { index: number; manifest?: NodeManifest }>();

  // --- node identity and type resolution ---------------------------------
  doc.nodes.forEach((node, index) => {
    if (nodeById.has(node.id)) {
      out.push({
        severity: 'error',
        code: 'DUPLICATE_ID',
        path: ['nodes', index, 'id'],
        message: `Two nodes share the id ${JSON.stringify(node.id)}. Ids key every journal entry and log line, so they must be unique.`,
      });
    }

    const manifest = registry.get(node.type, node.typeVersion);
    nodeById.set(node.id, { index, ...(manifest ? { manifest } : {}) });

    if (!manifest) {
      const known = registry.versions(node.type);
      if (known.length === 0) {
        out.push({
          severity: 'error',
          code: 'UNKNOWN_NODE_TYPE',
          path: ['nodes', index, 'type'],
          message: `No node type ${JSON.stringify(node.type)} is registered.`,
        });
      } else {
        out.push({
          severity: 'error',
          code: 'UNKNOWN_TYPE_VERSION',
          path: ['nodes', index, 'typeVersion'],
          message: `${node.type} has no version ${node.typeVersion}. Known versions: ${known.join(', ')}.`,
          quickFix: {
            title: `Migrate to version ${known[known.length - 1]}`,
            describe: 'Node packs ship a migration per version; loading applies it.',
          },
        });
      }
    }
  });

  // --- edges reference real nodes and real ports --------------------------
  const inboundByPort = new Map<string, number>();

  doc.edges.forEach((edge, index) => {
    const from = nodeById.get(edge.from.node);
    const to = nodeById.get(edge.to.node);

    if (!from) {
      out.push({
        severity: 'error',
        code: 'PORT_MISMATCH',
        path: ['edges', index, 'from', 'node'],
        message: `Edge starts at ${JSON.stringify(edge.from.node)}, which is not a node in this document.`,
      });
    }
    if (!to) {
      out.push({
        severity: 'error',
        code: 'PORT_MISMATCH',
        path: ['edges', index, 'to', 'node'],
        message: `Edge ends at ${JSON.stringify(edge.to.node)}, which is not a node in this document.`,
      });
    }
    if (!from || !to) return;

    if (from.manifest && !from.manifest.ports.outputs.some((p) => p.id === edge.from.port)) {
      out.push({
        severity: 'error',
        code: 'PORT_MISMATCH',
        path: ['edges', index, 'from', 'port'],
        message: `${from.manifest.type} has no output port ${JSON.stringify(edge.from.port)}. It has: ${from.manifest.ports.outputs.map((p) => p.id).join(', ')}.`,
      });
    }

    const inPort = to.manifest?.ports.inputs.find((p) => p.id === edge.to.port);
    if (to.manifest && !inPort) {
      out.push({
        severity: 'error',
        code: 'PORT_MISMATCH',
        path: ['edges', index, 'to', 'port'],
        message: `${to.manifest.type} has no input port ${JSON.stringify(edge.to.port)}. It has: ${to.manifest.ports.inputs.map((p) => p.id).join(', ')}.`,
      });
    }

    const key = `${edge.to.node}:${edge.to.port}`;
    const count = (inboundByPort.get(key) ?? 0) + 1;
    inboundByPort.set(key, count);
    if (inPort?.cardinality === 'one' && count > 1) {
      out.push({
        severity: 'error',
        code: 'PORT_OVERSUBSCRIBED',
        path: ['edges', index],
        message: `Port ${edge.to.port} on ${edge.to.node} accepts one inbound edge; this is number ${count}.`,
      });
    }
  });

  // --- required inputs are wired -----------------------------------------
  doc.nodes.forEach((node, index) => {
    const manifest = nodeById.get(node.id)?.manifest;
    if (!manifest || manifest.trigger) return;
    for (const port of manifest.ports.inputs) {
      if (!port.required) continue;
      const wired = doc.edges.some((e) => e.to.node === node.id && e.to.port === port.id);
      if (!wired) {
        out.push({
          severity: 'error',
          code: 'MISSING_REQUIRED_INPUT',
          path: ['nodes', index],
          // Written for the person on the canvas, who sees wires, not ports.
          message:
            port.id === 'main'
              ? `${node.label ?? node.id} has nothing wired into it yet.`
              : `${node.label ?? node.id} needs a wire into its "${port.id}" input.`,
        });
      }
    }
  });

  // --- required settings are filled in -----------------------------------
  //
  // Caught here rather than when the box runs, so an HTTP box with no address
  // is marked on the canvas the moment it is added, not discovered halfway
  // through a run after earlier boxes have already done their work.
  doc.nodes.forEach((node, index) => {
    const manifest = nodeById.get(node.id)?.manifest;
    if (!manifest || node.disabled) return;
    const fields = manifest.config?.fields ?? [];
    for (const field of fields) {
      if (!field.required || !fieldApplies(field, node.config, fields)) continue;
      const value = node.config[field.name] ?? field.default;
      if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
        out.push({
          severity: 'error',
          code: 'INVALID_CONFIG',
          path: ['nodes', index, 'config', field.name],
          message: `${node.label ?? node.id} needs its ${field.label ?? field.name} filled in.`,
        });
      }
    }
  });

  // --- there has to be somewhere to start --------------------------------
  const triggers = doc.nodes.filter((n) => nodeById.get(n.id)?.manifest?.trigger && !n.disabled);
  if (triggers.length === 0) {
    out.push({
      severity: 'error',
      code: 'NO_TRIGGER',
      path: ['nodes'],
      message: 'The workflow has no enabled trigger node, so nothing can start it.',
    });
  }

  // --- unreachable nodes are a warning, not an error ----------------------
  //
  // Warning rather than error on purpose: a half-built branch is a normal
  // state for a document someone is still editing, and refusing to save it
  // would make the editor fight the person using it.
  const reachable = new Set<string>(triggers.map((t) => t.id));
  let grew = true;
  while (grew) {
    grew = false;
    for (const edge of doc.edges) {
      if (reachable.has(edge.from.node) && !reachable.has(edge.to.node)) {
        reachable.add(edge.to.node);
        grew = true;
      }
    }
  }
  doc.nodes.forEach((node, index) => {
    if (!node.disabled && !reachable.has(node.id) && triggers.length > 0) {
      out.push({
        severity: 'warning',
        code: 'UNREACHABLE',
        path: ['nodes', index],
        message: `${node.label ?? node.id} cannot be reached from any trigger, so it will never run.`,
      });
    }
  });

  return out;
}

export const hasErrors = (diagnostics: Diagnostic[]): boolean =>
  diagnostics.some((d) => d.severity === 'error');

export function formatDiagnostic(d: Diagnostic): string {
  return `${d.severity.toUpperCase()} ${d.code} at ${d.path.join('.')}: ${d.message}`;
}
