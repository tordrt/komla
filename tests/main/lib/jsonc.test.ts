import { describe, it, expect } from 'vitest';

import { parseJsonc } from '../../../src/main/lib/jsonc';

describe('parseJsonc', () => {
  it('parses plain JSON', () => {
    expect(parseJsonc('{"a": 1}')).toEqual({ a: 1 });
  });

  it('strips single-line comments', () => {
    const input = `{
      "plugin": [
        // "/Users/foo/bar"
        "/Users/baz/qux"
      ]
    }`;
    expect(parseJsonc(input)).toEqual({ plugin: ['/Users/baz/qux'] });
  });

  it('strips multi-line comments', () => {
    const input = `{
      /* this is a comment */
      "key": "value"
    }`;
    expect(parseJsonc(input)).toEqual({ key: 'value' });
  });

  it('does not strip comment-like sequences inside strings', () => {
    const input = `{"url": "http://example.com"}`;
    expect(parseJsonc(input)).toEqual({ url: 'http://example.com' });
  });

  it('handles strings with escaped quotes', () => {
    const input = `{"msg": "he said \\"hello\\"", "a": 1}`;
    expect(parseJsonc(input)).toEqual({ msg: 'he said "hello"', a: 1 });
  });

  it('handles trailing commas are still invalid', () => {
    expect(() => parseJsonc('{"a": 1,}')).toThrow();
  });

  it('handles inline single-line comments', () => {
    const input = `{
      "a": 1, // inline comment
      "b": 2
    }`;
    expect(parseJsonc(input)).toEqual({ a: 1, b: 2 });
  });

  it('handles multi-line comment spanning lines', () => {
    const input = `{
      "a": 1,
      /*
        "removed": true,
      */
      "b": 2
    }`;
    expect(parseJsonc(input)).toEqual({ a: 1, b: 2 });
  });

  it('handles line comment at EOF without trailing newline', () => {
    expect(parseJsonc('{"a": 1} // trailing')).toEqual({ a: 1 });
  });

  it('throws on an unterminated string', () => {
    expect(() => parseJsonc('{"a": "oops')).toThrow();
  });
});
