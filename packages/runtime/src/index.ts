/**
 * @goblin/runtime — the scheduler, and nothing that performs an effect.
 *
 * Depends on spec, graph and expressions. It must never acquire a dependency
 * on a database, a queue or an HTTP client: the moment it does, the reusable
 * core stops being reusable and becomes one product's server.
 */
export * from './state.js';
export * from './protocol.js';
export * from './advance.js';
