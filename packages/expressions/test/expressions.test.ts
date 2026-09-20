import { describe, expect, it } from 'vitest';

import { ExpressionError, evaluate, resolveString, resolveValue } from '@goblin/expressions';

describe('resolving values', () => {
  it('keeps the type when the whole string is one hole', () => {
    // "{{ $json.count }}" must stay a number. Getting this wrong is how every
    // config value silently becomes a string and comparisons start lying.
    expect(resolveString('{{ $json.count }}', { json: { count: 3 } })).toBe(3);
    expect(resolveString('{{ $json.ok }}', { json: { ok: true } })).toBe(true);
    expect(resolveString('{{ $json.missing }}', { json: {} })).toBe(null);
  });

  it('interpolates two holes separated by a space', () => {
    // Regression: the "whole string is one expression" check used a lazy match
    // that spanned both holes, so this parsed as one expression whose body was
    // "$vars.greeting }} {{ $json.name" and failed the node outright.
    expect(resolveString('{{ $vars.greeting }} {{ $json.name }}', { vars: { greeting: 'hello' }, json: { name: 'world' } })).toBe(
      'hello world',
    );
  });

  it('interpolates when there is text around the hole', () => {
    expect(resolveString('order {{ $json.id }} total {{ $json.total }}', { json: { id: 'A1', total: 12 } })).toBe(
      'order A1 total 12',
    );
  });

  it('walks nested objects and arrays', () => {
    const resolved = resolveValue(
      { url: 'https://api/{{ $json.id }}', retries: '{{ $vars.retries }}', tags: ['{{ $json.tag }}'] },
      { json: { id: 7, tag: 'x' }, vars: { retries: 2 } },
    );
    expect(resolved).toEqual({ url: 'https://api/7', retries: 2, tags: ['x'] });
  });

  it('does arithmetic, comparison and the helpers', () => {
    const ctx = { json: { qty: 3, price: 4.5, name: ' Widget ' } };
    expect(evaluate('$json.qty * $json.price', ctx)).toBe(13.5);
    expect(evaluate('$json.qty > 2 && $json.price < 10', ctx)).toBe(true);
    expect(evaluate('trim($json.name)', ctx)).toBe('Widget');
    expect(evaluate('upper(trim($json.name))', ctx)).toBe('WIDGET');
    expect(evaluate('round($json.price, 0)', ctx)).toBe(5);
    expect(evaluate('default($json.nope, "fallback")', ctx)).toBe('fallback');
    expect(evaluate('length($items)', { items: [1, 2, 3] })).toBe(3);
  });

  it('supports conditionals and nullish fallback', () => {
    expect(evaluate('$json.n > 5 ? "big" : "small"', { json: { n: 9 } })).toBe('big');
    expect(evaluate('$json.missing ?? "none"', { json: {} })).toBe('none');
  });
});

describe('what expressions cannot do', () => {
  /**
   * These are the tests that matter most in this package. An expression comes
   * out of a document, and a document is editable by anyone who can edit a
   * workflow — so the language has to be unable to reach the host, not merely
   * unlikely to.
   */

  it('cannot climb the prototype chain to reach a function constructor', () => {
    expect(evaluate('$json.constructor', { json: { a: 1 } })).toBe(null);
    expect(evaluate('$json.__proto__', { json: { a: 1 } })).toBe(null);
    expect(evaluate('$json.a.constructor.constructor', { json: { a: 1 } })).toBe(null);
  });

  it('cannot reach globals', () => {
    for (const source of ['process', 'globalThis', 'require', 'fetch', 'eval', 'Function']) {
      expect(() => evaluate(source, {})).toThrow(ExpressionError);
    }
  });

  it('cannot call a function that is not on the allowlist', () => {
    expect(() => evaluate('exec("rm -rf /")', {})).toThrow(/No function named exec/);
  });

  it('cannot read the clock, so a replay matches the run it replays', () => {
    expect(() => evaluate('now()', {})).toThrow(ExpressionError);
    expect(() => evaluate('Date.now()', {})).toThrow(ExpressionError);
  });

  it('reports a syntax error instead of throwing something unrecognisable', () => {
    expect(() => evaluate('$json.', {})).toThrow(ExpressionError);
    expect(() => evaluate('"unterminated', {})).toThrow(/Unterminated string/);
  });
});
