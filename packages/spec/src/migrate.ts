import type { JsonObject, WorkflowDocument } from './types.js';

/**
 * Document migrations are forward-only and pure.
 *
 * Loading always migrates first, so nothing downstream — not the engine, not
 * the editor, not a test fixture — ever sees an old shape. The alternative is
 * version checks scattered through every consumer, which is how a format ends
 * up with three half-supported variants nobody dares delete.
 */
export interface DocumentMigration {
  to: number;
  describe: string;
  up: (doc: JsonObject) => JsonObject;
}

export const CURRENT_SCHEMA_VERSION = 1;

/**
 * Empty at v1, and deliberately not deleted.
 *
 * The migration path exists before it is needed because the first migration
 * written after the format has shipped has to cope with documents that were
 * saved without one. Starting with the machinery in place costs nothing now.
 */
export const documentMigrations: DocumentMigration[] = [];

export interface MigrationResult {
  document: WorkflowDocument;
  applied: string[];
}

export function migrateDocument(raw: unknown): MigrationResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new TypeError('A workflow document must be a JSON object.');
  }

  let doc = raw as JsonObject;
  const version = typeof doc['schemaVersion'] === 'number' ? doc['schemaVersion'] : 0;
  const applied: string[] = [];

  if (version > CURRENT_SCHEMA_VERSION) {
    // Refusing is the honest outcome: a newer document may use fields this
    // build would silently drop on the next save, which loses a person's work
    // in a way they will not notice until much later.
    throw new Error(
      `This document is schemaVersion ${version}; this build understands up to ${CURRENT_SCHEMA_VERSION}. Upgrade GoblinKit to open it.`,
    );
  }

  for (const migration of documentMigrations) {
    if (version < migration.to) {
      doc = migration.up(doc);
      doc['schemaVersion'] = migration.to;
      applied.push(`${migration.to}: ${migration.describe}`);
    }
  }

  if (typeof doc['schemaVersion'] !== 'number') doc['schemaVersion'] = CURRENT_SCHEMA_VERSION;
  return { document: doc as unknown as WorkflowDocument, applied };
}

/* ------------------------------------------------------------------------ *
 * Box type versions (§4.4, ADR-009)
 *
 * A box whose settings changed shape gets a new typeVersion and a migration
 * from each older one. Documents are upgraded box by box when they are
 * loaded, so a workflow saved with HTTP Request v1 opens as v2. The old
 * version stays registered too, so a document nobody has reopened still runs.
 * ------------------------------------------------------------------------ */

export interface NodeMigration {
  type: string;
  from: number;
  to: number;
  up: (config: JsonObject) => JsonObject;
}

export interface NodeMigrationResult {
  document: WorkflowDocument;
  /** "box-id: core.http.request 1 → 2", one per box upgraded. */
  applied: string[];
}

/** Upgrade every box that has a migration path to a newer version. Pure. */
export function migrateNodes(document: WorkflowDocument, migrations: readonly NodeMigration[]): NodeMigrationResult {
  if (!migrations.length) return { document, applied: [] };
  const applied: string[] = [];
  const nodes = document.nodes.map((node) => {
    let current = node;
    for (let guard = 0; guard < 100; guard++) {
      const step = migrations.find((m) => m.type === current.type && m.from === current.typeVersion);
      if (!step) break;
      current = { ...current, typeVersion: step.to, config: step.up({ ...current.config }) };
    }
    if (current !== node) applied.push(`${node.id}: ${node.type} ${node.typeVersion} → ${current.typeVersion}`);
    return current;
  });
  return applied.length ? { document: { ...document, nodes }, applied } : { document, applied };
}
