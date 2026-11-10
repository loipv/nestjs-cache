import { describe, expect, it } from 'vitest';
import { CacheConfigError } from '../../../src/errors.js';
import {
  compileTemplate,
  defaultKey,
  fullKey,
  namespacePrefix,
  stableStringify,
} from '../../../src/core/key-builder.js';

describe('key-builder', () => {
  it.each([
    ['user:{0}', ['42'], 'user:42'],
    ['u:{0.id}:{1}', [{ id: 7 }, true], 'u:7:true'],
    ['static', [], 'static'],
    ['u:{0.a.b}', [{}], 'u:undefined'],
    ['u:{0.a.b}', [null], 'u:undefined'],
    ['n:{0}', [null], 'n:null'],
    ['f:{0}', [{ b: 1, a: 2 }], 'f:{"a":2,"b":1}'],
    ['{1}-{0}', ['a', 'b'], 'b-a'],
  ] as const)('template %s', (template, args, expected) => {
    expect(compileTemplate(template)(args)).toBe(expected);
  });

  it.each(['{id}', 'user:{0', 'user:0}', '{0.}', '{-1}', '{0.a b}', '{}', '{0}{'])(
    'rejects template %s',
    (t) => {
      expect(() => compileTemplate(t)).toThrow(CacheConfigError);
    },
  );

  it('stableStringify sorts keys recursively', () => {
    expect(stableStringify({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
  });

  it('stableStringify distinguishes undefined from null', () => {
    expect(stableStringify([undefined])).not.toBe(stableStringify([null]));
    expect(stableStringify(undefined)).not.toBe(stableStringify(null));
  });

  it('stableStringify handles Date, bigint and class instances', () => {
    expect(stableStringify(new Date(0))).toBe('"1970-01-01T00:00:00.000Z"');
    expect(stableStringify(10n)).toBe('10n');
    class Dto {
      constructor(
        public b = 1,
        public a = 2,
      ) {}
    }
    expect(stableStringify(new Dto())).toBe('{"a":2,"b":1}');
  });

  it.each([new Map([[1, 2]]), new Set([1]), new WeakMap(), new WeakSet(), () => 1, Symbol('s')])(
    'stableStringify rejects %s (Review Focus 5)',
    (v) => {
      expect(() => stableStringify(v)).toThrow(TypeError);
      expect(() => defaultKey('C', 'm', [v])).toThrow(TypeError);
      expect(() => stableStringify({ p: v })).toThrow(TypeError);
      expect(() => stableStringify([v])).toThrow(TypeError);
    },
  );

  it('stableStringify rejects cycles', () => {
    const o: Record<string, unknown> = {};
    o.self = o;
    expect(() => stableStringify(o)).toThrow(TypeError);
  });

  it('stableStringify allows a repeated non-cyclic reference', () => {
    const shared = { a: 1 };
    expect(stableStringify({ x: shared, y: shared })).toBe('{"x":{"a":1},"y":{"a":1}}');
  });

  it('stableStringify omits undefined properties', () => {
    expect(stableStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it('defaultKey has no hash without arguments', () => {
    expect(defaultKey('UserService', 'findAll', [])).toBe('UserService.findAll');
  });

  it('defaultKey hashes arguments deterministically', () => {
    const k = defaultKey('UserService', 'find', ['42']);
    expect(k).toMatch(/^UserService\.find:[0-9a-f]{16}$/);
    expect(defaultKey('UserService', 'find', ['42'])).toBe(k);
    expect(defaultKey('UserService', 'find', ['43'])).not.toBe(k);
    expect(defaultKey('C', 'm', [{ a: 1, b: 2 }])).toBe(defaultKey('C', 'm', [{ b: 2, a: 1 }]));
  });

  it.each([
    ['app', 'users', 'user:1', 'app:users:user:1'],
    [undefined, 'users', 'k', 'users:k'],
    ['app', undefined, 'k', 'app:k'],
    [undefined, undefined, 'k', 'k'],
    ['', '', 'k', 'k'],
  ] as const)('fullKey(%s, %s, %s)', (p, n, k, expected) => {
    expect(fullKey(p, n, k)).toBe(expected);
  });

  it('namespacePrefix ends with a colon', () => {
    expect(namespacePrefix('app', 'users')).toBe('app:users:');
    expect(namespacePrefix(undefined, 'users')).toBe('users:');
  });
});
