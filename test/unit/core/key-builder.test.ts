import { describe, expect, it } from 'vitest';
import { CacheConfigError } from '../../../src/errors.js';
import {
  compileTemplate,
  defaultKey,
  fullKey,
  isReservedKey,
  isReservedNamespace,
  lockKey,
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

  it('stableStringify allows one object reused across a wide, deep acyclic structure', () => {
    /* the same object sits in sibling positions at several depths: only an ancestor is a cycle */
    const shared = { id: 1, tags: ['a'] };
    let deep: unknown = { leaf: shared };
    for (let i = 0; i < 200; i += 1) deep = { next: deep, also: shared };
    const wide = Array.from({ length: 500 }, (_, i) => (i % 2 === 0 ? shared : [shared, shared]));
    const value = { wide, deep, pair: [shared, { inner: shared }] };
    const out = stableStringify(value);
    expect(out.startsWith('{"deep":{"also":{"id":1,"tags":["a"]},"next":{"also":')).toBe(true);
    expect(out.split('{"id":1,"tags":["a"]}')).toHaveLength(201 + 750 + 2 + 1);
    expect(stableStringify({ pair: value.pair })).toBe(
      '{"pair":[{"id":1,"tags":["a"]},{"inner":{"id":1,"tags":["a"]}}]}',
    );
  });

  it('stableStringify still rejects a cycle deep down and a toJSON returning itself', () => {
    const a: Record<string, unknown> = {};
    const b: Record<string, unknown> = { a };
    a.list = [1, { b }];
    expect(() => stableStringify({ root: a })).toThrow(
      'Cannot build a cache key from a circular structure',
    );
    const selfish = {
      toJSON(): unknown {
        return selfish;
      },
    };
    expect(() => stableStringify([selfish])).toThrow(
      'Cannot build a cache key from a circular structure',
    );
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

describe('lockKey and isReservedNamespace', () => {
  it('puts the lock key under the prefix and the __lock__ segment', () => {
    /* prefix, namespace and key combinations of lockKey */
    expect(lockKey('app', 'users', '1')).toBe('app:__lock__:users:1');
    expect(lockKey(undefined, 'users', '1')).toBe('__lock__:users:1');
    expect(lockKey('app', undefined, 'k')).toBe('app:__lock__:k');
  });

  it('reserves namespaces starting with two underscores only', () => {
    /* one underscore is a normal namespace */
    expect(isReservedNamespace('__x')).toBe(true);
    expect(isReservedNamespace('__')).toBe(true);
    expect(isReservedNamespace('_x')).toBe(false);
    expect(isReservedNamespace('x__')).toBe(false);
  });
});

describe('compileTemplate escape flag', () => {
  /* Escaping is opt-in: % becomes %25 first, then : becomes %3A, in string arguments. */
  it('escapes % and : in string args when asked', () => {
    expect(compileTemplate('user:{0}:{1}')(['a:b', 'c%d'], true)).toBe('user:a%3Ab:c%25d');
  });

  /* The 0.3 output is kept when the flag is omitted. */
  it('leaves args untouched without the flag', () => {
    expect(compileTemplate('user:{0}:{1}')(['a:b', 'c%d'])).toBe('user:a:b:c%d');
  });

  /* The % is escaped before the colon, so a literal %3A in the input does not collapse onto a colon. */
  it('escapes % before :', () => {
    expect(compileTemplate('{0}')(['%3A:'], true)).toBe('%253A%3A');
  });

  /* Numbers carry no % or :, so escaping leaves them as they are. */
  it('renders numbers unchanged when escaped', () => {
    expect(compileTemplate('{0}')([5], true)).toBe('5');
  });

  /* Objects keep their stableStringify output; the strings inside them are not escaped. */
  it('does not escape stringified objects', () => {
    const render = compileTemplate('{0}');
    expect(render([{ a: 'x:y' }], true)).toBe(render([{ a: 'x:y' }]));
  });

  /* A path segment resolved to a string is escaped like a top-level string. */
  it('escapes strings resolved through a path', () => {
    expect(compileTemplate('{0.id}')([{ id: 'a:b' }], true)).toBe('a%3Ab');
  });
});

describe('isReservedKey', () => {
  it('reserves keys starting with two underscores only without a namespace', () => {
    expect(isReservedKey(undefined, '__version__:users')).toBe(true);
    expect(isReservedKey(undefined, '__')).toBe(true);
    expect(isReservedKey(undefined, '_x')).toBe(false);
    expect(isReservedKey(undefined, 'a__b')).toBe(false);
    expect(isReservedKey('', '__x')).toBe(true);
    expect(isReservedKey('users', '__x')).toBe(false);
  });
});
