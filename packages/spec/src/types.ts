/**
 * The workflow document, and the things that travel between nodes.
 *
 * This package depends on nothing. That is not tidiness — it is the load-
 * bearing constraint of the whole kit. The document is the only contract
 * shared by the editor, the engine and storage, so if it could reach for a
 * runtime type, a React component or a database row, all three would be
 * welded together and the "kit" would be one product's internals.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type WorkflowId = string;
export type TenantId = string;
export type NodeId = string;
export type EdgeId = string;
export type PortId = string;
export type NodeTypeId = string;

/**
 * An expression is a string that may contain `{{ ... }}` holes. It is kept as
 * a distinct type so that "this field is evaluated later" is visible in the
 * document rather than being a convention nodes remember individually.
 */
export type Expression = string;

/** A path into the document, for diagnostics: ['nodes', 3, 'config', 'url']. */
export type DocumentPath = (string | number)[];

export interface XY {
  x: number;
  y: number;
}

/**
 * A reference to a credential. Never the credential itself.
 *
 * A secret value that never enters the document cannot leak through an export,
 * a version diff, a screenshot of the editor, or a support ticket — none of
 * which are places anyone chooses to put secrets, and all of which is where
 * they end up when the document is allowed to hold them.
 */
export interface CredentialRef {
  id: string;
  type: string;
}

export type JoinPolicy = 'all' | 'any' | 'race' | 'collect';
export type ExecutionMode = 'batch' | 'perItem' | 'single';
export type Cardinality = 'one' | 'many';

export interface PortSpec {
  id: PortId;
  label?: string;
  /** Input only. A node whose required inputs are all pruned is skipped. */
  required?: boolean;
  /** Input only. Defaults to 'all'. */
  join?: JoinPolicy;
  /** May more than one edge attach here? Defaults to 'many'. */
  cardinality?: Cardinality;
}

export interface RetryPolicy {
  maxAttempts: number;
  /** Delay before the first retry; doubled per attempt up to maxBackoffMs. */
  backoffMs: number;
  maxBackoffMs: number;
}

export type OnErrorBehaviour = 'fail' | 'continue' | 'route';

export interface NodePolicy {
  retry: RetryPolicy;
  timeoutMs: number;
  /**
   * 'fail'     — the run fails (default)
   * 'continue' — the node emits nothing and the run carries on
   * 'route'    — the error is delivered on the node's `error` port
   */
  onError: OnErrorBehaviour;
}

export type Rotation = 0 | 90 | 180 | 270;

export interface NodeInstance {
  /** Stable and opaque. Labels change freely; this never does. */
  id: NodeId;
  type: NodeTypeId;
  typeVersion: number;
  label?: string;
  config: JsonObject;
  credentials?: Record<string, CredentialRef>;
  policy?: Partial<NodePolicy>;
  /**
   * Presentation, quarantined. A headless consumer ignores it entirely, and
   * moving a node on the canvas produces a diff that is obviously non-semantic.
   */
  ui?: {
    position?: XY;
    width?: number;
    collapsed?: boolean;
    notes?: string;
    /**
     * Which way the box faces, in degrees clockwise. 0: wires come in at the
     * top and leave at the bottom; 90: in on the right, out on the left; and
     * so on. The card and its text never turn — only where its wires attach.
     */
    rotation?: Rotation;
  };
  disabled?: boolean;
  /** Authoring aid: short-circuits execution with a fixed envelope. */
  pinnedData?: Envelope;
}

export interface Edge {
  id: EdgeId;
  from: { node: NodeId; port: PortId };
  to: { node: NodeId; port: PortId };
  /** Optional gate evaluated against the source envelope. */
  condition?: Expression;
  ui?: { label?: string; waypoints?: XY[] };
}

export interface WorkflowSettings {
  /** Ceiling on every scope in the document unless a scope narrows it. */
  maxIterations?: number;
  maxDurationMs?: number;
  defaultPolicy?: Partial<NodePolicy>;
}

export interface DocumentMeta {
  createdAt?: string;
  updatedAt?: string;
  author?: string;
  tags?: string[];
}

export interface WorkflowDocument {
  /** Document schema version — drives migrations. Not the workflow's version. */
  schemaVersion: number;
  id: WorkflowId;
  tenantId: TenantId;
  name: string;
  description?: string;
  nodes: NodeInstance[];
  edges: Edge[];
  /** Workflow-scoped values, readable as {{ $vars.x }}. Never secrets. */
  variables?: Record<string, JsonValue>;
  settings?: WorkflowSettings;
  meta?: DocumentMeta;
}

/* ------------------------------------------------------------------------ *
 * What flows on an edge
 * ------------------------------------------------------------------------ */

export interface BinaryRef {
  key: string;
  mimeType: string;
  size: number;
  fileName?: string;
}

/**
 * Where an item came from. Mandatory rather than optional, because "which
 * input produced this output" has to be threaded through from the first line
 * of the first node or it can never be added — and it is the thing people
 * need most when a run does something surprising.
 */
export type Lineage = { sourceNode: NodeId; sourcePort: PortId; itemIndex: number }[];

export interface ItemError {
  message: string;
  code?: string;
  retryable?: boolean;
}

export interface Item {
  data: JsonValue;
  binary?: Record<string, BinaryRef>;
  lineage?: Lineage;
  /** A per-item failure. One bad record in a hundred must not fail the batch. */
  error?: ItemError;
}

export interface EnvelopeMeta {
  node?: NodeId;
  port?: PortId;
  scopePath?: string;
  emittedAt?: number;
}

export interface Envelope {
  items: Item[];
  meta?: EnvelopeMeta;
}

export const emptyEnvelope = (meta?: EnvelopeMeta): Envelope => ({ items: [], ...(meta ? { meta } : {}) });

/* ------------------------------------------------------------------------ *
 * Diagnostics
 * ------------------------------------------------------------------------ */

export type DiagnosticCode =
  | 'UNKNOWN_NODE_TYPE'
  | 'UNKNOWN_TYPE_VERSION'
  | 'PORT_MISMATCH'
  | 'UNSCOPED_CYCLE'
  | 'MISSING_REQUIRED_INPUT'
  | 'UNREACHABLE'
  | 'INVALID_CONFIG'
  | 'INVALID_REFERENCE'
  | 'PORT_OVERSUBSCRIBED'
  | 'DUPLICATE_ID'
  | 'NO_TRIGGER'
  | 'SCOPE_UNBALANCED';

export interface Diagnostic {
  severity: 'error' | 'warning' | 'info';
  code: DiagnosticCode;
  path: DocumentPath;
  message: string;
  /** A machine-applicable suggestion, where one exists. */
  quickFix?: { title: string; describe: string };
}

/* ------------------------------------------------------------------------ *
 * Node manifests
 *
 * A manifest is DATA: serialisable, fetchable, analysable, and safe to send to
 * a browser. The executor that goes with it is code and stays on the server.
 * Keeping the two apart is what lets the editor render a node it has never
 * heard of without also shipping that node's server dependencies.
 * ------------------------------------------------------------------------ */

export interface ScopeSpec {
  /** A node that opens a scope, and the kind of loop it runs. */
  role: 'start' | 'end';
  kind?: 'forEach' | 'while';
}

export interface NodeManifest {
  type: NodeTypeId;
  version: number;
  title: string;
  group: string;
  description?: string;
  /** How the executor consumes its input envelope. */
  executionMode: ExecutionMode;
  ports: {
    inputs: PortSpec[];
    outputs: PortSpec[];
  };
  /** Config field descriptions, as data. Validation lives in `validateConfig`. */
  config?: {
    fields?: ConfigField[];
  };
  /** Marks the node as a trigger: a run starts at it and it takes no input. */
  trigger?: boolean;
  /** Present only on scope nodes, which the engine treats specially. */
  scope?: ScopeSpec;
  defaults?: { policy?: Partial<NodePolicy> };
}

export interface ConfigField {
  name: string;
  label?: string;
  type: 'string' | 'number' | 'boolean' | 'json' | 'expression' | 'select';
  required?: boolean;
  default?: JsonValue;
  options?: string[];
  description?: string;
  /**
   * Show (and require) this field only while another field has one of these
   * values — the cron box only when "Repeat" is set to cron. Data, so the
   * settings panel and the validator agree without knowing the box.
   */
  showWhen?: { field: string; equals: string[] };
}

/** Whether a field applies, given the box's current settings (defaults filled in). */
export function fieldApplies(field: ConfigField, config: Record<string, JsonValue | undefined>, fields: ConfigField[]): boolean {
  if (!field.showWhen) return true;
  const other = fields.find((f) => f.name === field.showWhen!.field);
  const value = config[field.showWhen.field] ?? other?.default;
  return typeof value === 'string' && field.showWhen.equals.includes(value);
}
