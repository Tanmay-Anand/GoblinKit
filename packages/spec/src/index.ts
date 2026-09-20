/**
 * @goblin/spec — the workflow document and what travels between nodes.
 *
 * Depends on nothing, by design. See ARCHITECTURE.md §3: the reuse boundary
 * is the line under @goblin/runtime, and this package sits at the bottom of it.
 */
export * from './types.js';
export * from './validate.js';
export * from './migrate.js';
