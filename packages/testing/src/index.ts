/**
 * @goblin/testing — the regression net the rest of the product leans on.
 *
 * Two tools. The golden-file harness turns a run into a readable trace and
 * diffs it against a checked-in file, so a scheduling regression shows up as
 * a one-line diff in review instead of as a customer's workflow doing
 * something new. The contract check is the rule set every node pack must pass
 * before the editor can render it and the engine can schedule it.
 */

export { formatTrace, matchGolden, traceRun, type GoldenResult, type TraceOptions } from './golden.js';
export { checkNodePack, type NodePackInput } from './contract.js';
