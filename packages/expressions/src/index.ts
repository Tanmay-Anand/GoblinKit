/**
 * @goblin/expressions — `{{ ... }}` resolution, without `eval`.
 *
 * Expressions are the first thing a workflow author reaches for and the
 * easiest place to open a hole: the obvious implementation is `new Function`
 * or `eval` over a string that came out of a document, which hands anyone who
 * can edit a workflow the whole server process.
 *
 * So this is a small interpreter over a deliberately tiny language: property
 * paths, array indexing, string/number/boolean literals, a handful of pure
 * helper functions, and nothing else. No assignment, no calls into arbitrary
 * objects, no prototype access, no loops. It cannot do very much — which is
 * the specification, not a shortcoming. Anything larger belongs in a Code node
 * behind a real sandbox boundary (ARCHITECTURE.md §13), not in a field.
 */

import type { JsonValue } from '@goblin/spec';

export interface ResolveContext {
  /** Output of earlier nodes: $node['id'].data, or $json for the current input. */
  readonly json?: JsonValue;
  readonly items?: readonly JsonValue[];
  readonly nodes?: Readonly<Record<string, JsonValue>>;
  readonly vars?: Readonly<Record<string, JsonValue>>;
  /** Loop context: index and value of the current iteration, when inside one. */
  readonly loop?: Readonly<Record<string, JsonValue>>;
  readonly run?: Readonly<Record<string, JsonValue>>;
}

export class ExpressionError extends Error {
  constructor(
    message: string,
    readonly expression: string,
  ) {
    super(message);
    this.name = 'ExpressionError';
  }
}

const HOLE = /\{\{([\s\S]*?)\}\}/g;

/** Does this string contain any `{{ }}` at all? */
export function isExpression(value: unknown): value is string {
  return typeof value === 'string' && value.includes('{{');
}

/**
 * Resolve a single value.
 *
 * A string that is exactly one hole (`"{{ $json.count }}"`) returns the typed
 * value, so a number stays a number. A string with text around the hole
 * interpolates and returns a string. Getting that distinction wrong is how
 * every config value silently becomes a string.
 */
export function resolveValue(value: JsonValue, ctx: ResolveContext): JsonValue {
  if (typeof value === 'string') return resolveString(value, ctx);
  if (Array.isArray(value)) return value.map((v) => resolveValue(v, ctx));
  if (value && typeof value === 'object') {
    const out: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveValue(v, ctx);
    return out;
  }
  return value;
}

export function resolveString(input: string, ctx: ResolveContext): JsonValue {
  if (!input.includes('{{')) return input;

  // One hole and nothing else returns the TYPED value. The interior must not
  // itself contain "}}", or "{{ a }} {{ b }}" matches as a single hole whose
  // body is "a }} {{ b" — which parses as garbage and fails the node.
  const whole = input.match(/^\s*\{\{((?:(?!\}\})[\s\S])*)\}\}\s*$/);
  if (whole && whole[1] !== undefined) return evaluate(whole[1], ctx);

  return input.replace(HOLE, (_match, body: string) => {
    const result = evaluate(body, ctx);
    if (result === null || result === undefined) return '';
    return typeof result === 'object' ? JSON.stringify(result) : String(result);
  });
}

/* ------------------------------------------------------------------------ *
 * The interpreter
 * ------------------------------------------------------------------------ */

type Token =
  | { t: 'ident'; v: string }
  | { t: 'number'; v: number }
  | { t: 'string'; v: string }
  | { t: 'punct'; v: string };

function tokenize(src: string, expression: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let out = '';
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < src.length) {
          out += src[i + 1];
          i += 2;
          continue;
        }
        out += src[i];
        i++;
      }
      if (i >= src.length) throw new ExpressionError('Unterminated string', expression);
      i++;
      tokens.push({ t: 'string', v: out });
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let out = '';
      while (i < src.length && /[0-9._]/.test(src[i]!)) out += src[i++];
      tokens.push({ t: 'number', v: Number(out.replace(/_/g, '')) });
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let out = '';
      while (i < src.length && /[A-Za-z0-9_$]/.test(src[i]!)) out += src[i++];
      tokens.push({ t: 'ident', v: out });
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['==', '!=', '>=', '<=', '&&', '||', '??'].includes(two)) {
      tokens.push({ t: 'punct', v: two });
      i += 2;
      continue;
    }
    if ('.[](),+-*/%<>!?:'.includes(ch)) {
      tokens.push({ t: 'punct', v: ch });
      i++;
      continue;
    }
    throw new ExpressionError(`Unexpected character ${JSON.stringify(ch)}`, expression);
  }
  return tokens;
}

/**
 * The only functions an expression can call.
 *
 * An allowlist, not a blocklist, and every entry is pure. `Date.now` is absent
 * on purpose: a workflow that reads the clock from an expression is a workflow
 * whose replay does not match its original run, and replay is the feature the
 * whole engine is built around.
 */
const FUNCTIONS: Record<string, (...args: JsonValue[]) => JsonValue> = {
  length: (v) => (Array.isArray(v) ? v.length : typeof v === 'string' ? v.length : 0),
  upper: (v) => String(v ?? '').toUpperCase(),
  lower: (v) => String(v ?? '').toLowerCase(),
  trim: (v) => String(v ?? '').trim(),
  number: (v) => Number(v ?? 0),
  string: (v) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)),
  boolean: (v) => Boolean(v),
  json: (v) => JSON.stringify(v ?? null),
  keys: (v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v) : []),
  values: (v) => (v && typeof v === 'object' && !Array.isArray(v) ? (Object.values(v) as JsonValue[]) : []),
  first: (v) => (Array.isArray(v) ? (v[0] ?? null) : null),
  last: (v) => (Array.isArray(v) ? (v[v.length - 1] ?? null) : null),
  includes: (haystack, needle) =>
    Array.isArray(haystack)
      ? haystack.some((x) => x === needle)
      : String(haystack ?? '').includes(String(needle ?? '')),
  default: (v, fallback) => (v === null || v === undefined || v === '' ? (fallback ?? null) : v),
  round: (v, digits) => {
    const factor = 10 ** Number(digits ?? 0);
    return Math.round(Number(v ?? 0) * factor) / factor;
  },
};

class Parser {
  private pos = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly ctx: ResolveContext,
    private readonly expression: string,
  ) {}

  parse(): JsonValue {
    const value = this.ternary();
    if (this.pos < this.tokens.length) {
      throw new ExpressionError(`Unexpected trailing input in ${JSON.stringify(this.expression)}`, this.expression);
    }
    return value;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private eat(v: string): boolean {
    const t = this.peek();
    if (t && t.t === 'punct' && t.v === v) {
      this.pos++;
      return true;
    }
    return false;
  }

  private ternary(): JsonValue {
    const condition = this.nullish();
    if (this.eat('?')) {
      const whenTrue = this.ternary();
      if (!this.eat(':')) throw new ExpressionError('Expected ":" in conditional', this.expression);
      const whenFalse = this.ternary();
      return truthy(condition) ? whenTrue : whenFalse;
    }
    return condition;
  }

  private nullish(): JsonValue {
    let left = this.or();
    while (this.eat('??')) {
      const right = this.or();
      left = left === null || left === undefined ? right : left;
    }
    return left;
  }

  private or(): JsonValue {
    let left = this.and();
    while (this.eat('||')) {
      const right = this.and();
      left = truthy(left) ? left : right;
    }
    return left;
  }

  private and(): JsonValue {
    let left = this.comparison();
    while (this.eat('&&')) {
      const right = this.comparison();
      left = truthy(left) ? right : left;
    }
    return left;
  }

  private comparison(): JsonValue {
    let left = this.additive();
    for (;;) {
      const t = this.peek();
      if (!t || t.t !== 'punct') return left;
      if (!['==', '!=', '>', '<', '>=', '<='].includes(t.v)) return left;
      this.pos++;
      const right = this.additive();
      switch (t.v) {
        case '==':
          left = left === right;
          break;
        case '!=':
          left = left !== right;
          break;
        case '>':
          left = Number(left) > Number(right);
          break;
        case '<':
          left = Number(left) < Number(right);
          break;
        case '>=':
          left = Number(left) >= Number(right);
          break;
        case '<=':
          left = Number(left) <= Number(right);
          break;
      }
    }
  }

  private additive(): JsonValue {
    let left = this.multiplicative();
    for (;;) {
      if (this.eat('+')) {
        const right = this.multiplicative();
        left =
          typeof left === 'string' || typeof right === 'string'
            ? `${stringify(left)}${stringify(right)}`
            : Number(left) + Number(right);
        continue;
      }
      if (this.eat('-')) {
        left = Number(left) - Number(this.multiplicative());
        continue;
      }
      return left;
    }
  }

  private multiplicative(): JsonValue {
    let left = this.unary();
    for (;;) {
      if (this.eat('*')) {
        left = Number(left) * Number(this.unary());
        continue;
      }
      if (this.eat('/')) {
        left = Number(left) / Number(this.unary());
        continue;
      }
      if (this.eat('%')) {
        left = Number(left) % Number(this.unary());
        continue;
      }
      return left;
    }
  }

  private unary(): JsonValue {
    if (this.eat('!')) return !truthy(this.unary());
    if (this.eat('-')) return -Number(this.unary());
    return this.postfix();
  }

  private postfix(): JsonValue {
    let value = this.primary();
    for (;;) {
      if (this.eat('.')) {
        const t = this.peek();
        if (!t || t.t !== 'ident') throw new ExpressionError('Expected a property name after "."', this.expression);
        this.pos++;
        value = member(value, t.v);
        continue;
      }
      if (this.eat('[')) {
        const key = this.ternary();
        if (!this.eat(']')) throw new ExpressionError('Expected "]"', this.expression);
        value = member(value, typeof key === 'number' ? key : String(key));
        continue;
      }
      return value;
    }
  }

  private primary(): JsonValue {
    const t = this.peek();
    if (!t) throw new ExpressionError('Unexpected end of expression', this.expression);

    if (t.t === 'number' || t.t === 'string') {
      this.pos++;
      return t.v;
    }
    if (t.t === 'punct' && t.v === '(') {
      this.pos++;
      const value = this.ternary();
      if (!this.eat(')')) throw new ExpressionError('Expected ")"', this.expression);
      return value;
    }
    if (t.t === 'ident') {
      this.pos++;
      switch (t.v) {
        case 'true':
          return true;
        case 'false':
          return false;
        case 'null':
          return null;
      }

      // A call, if the next token opens a paren.
      const next = this.peek();
      if (next && next.t === 'punct' && next.v === '(') {
        this.pos++;
        const args: JsonValue[] = [];
        if (!this.eat(')')) {
          do {
            args.push(this.ternary());
          } while (this.eat(','));
          if (!this.eat(')')) throw new ExpressionError('Expected ")"', this.expression);
        }
        const fn = FUNCTIONS[t.v];
        if (!fn) {
          throw new ExpressionError(
            `No function named ${t.v}. Available: ${Object.keys(FUNCTIONS).join(', ')}.`,
            this.expression,
          );
        }
        return fn(...args);
      }

      return this.root(t.v);
    }
    throw new ExpressionError(`Unexpected token ${JSON.stringify(t.v)}`, this.expression);
  }

  /** The named roots an expression may start from. Nothing else is visible. */
  private root(name: string): JsonValue {
    switch (name) {
      case '$json':
        return this.ctx.json ?? null;
      case '$items':
        return (this.ctx.items as JsonValue) ?? [];
      case '$node':
        return (this.ctx.nodes as JsonValue) ?? {};
      case '$vars':
        return (this.ctx.vars as JsonValue) ?? {};
      case '$loop':
        return (this.ctx.loop as JsonValue) ?? {};
      case '$run':
        return (this.ctx.run as JsonValue) ?? {};
      default:
        throw new ExpressionError(
          `${name} is not available in expressions. Use $json, $items, $node, $vars, $loop or $run.`,
          this.expression,
        );
    }
  }
}

export function evaluate(source: string, ctx: ResolveContext): JsonValue {
  const tokens = tokenize(source, source);
  if (tokens.length === 0) return null;
  return new Parser(tokens, ctx, source).parse();
}

/**
 * Property access that cannot climb the prototype chain.
 *
 * `{{ $json.constructor.constructor('...')() }}` is the classic escape from a
 * naive interpreter, and it is closed here rather than by hoping no document
 * ever contains it.
 */
function member(value: JsonValue, key: string | number): JsonValue {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    if (typeof key === 'number') return value[key] ?? null;
    if (key === 'length') return value.length;
    return null;
  }
  if (typeof value === 'object') {
    if (!Object.prototype.hasOwnProperty.call(value, key)) return null;
    return (value as Record<string, JsonValue>)[String(key)] ?? null;
  }
  if (typeof value === 'string') {
    if (key === 'length') return value.length;
    if (typeof key === 'number') return value[key] ?? null;
  }
  return null;
}

const truthy = (v: JsonValue): boolean => {
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === 'object') return Object.keys(v).length > 0;
  return Boolean(v);
};

const stringify = (v: JsonValue): string =>
  v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
