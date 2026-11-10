import { createHash } from 'node:crypto';
import { CacheConfigError } from '../errors.js';

type Segment = string | { readonly index: number; readonly path: readonly string[] };

const PLACEHOLDER = /\{(\d+)((?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)\}/y;

export function stableStringify(value: unknown): string {
  return stringifyValue(value, new Set());
}

/** `ancestors` holds the objects on the path from the root: one seen again there is a cycle. */
function stringifyValue(value: unknown, ancestors: Set<object>): string {
  switch (typeof value) {
    case 'undefined':
      return 'undefined';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      return Number.isFinite(value) ? JSON.stringify(value) : String(value);
    case 'boolean':
      return String(value);
    case 'bigint':
      return `${value.toString()}n`;
    case 'symbol':
      throw new TypeError('Cannot build a cache key from a symbol');
    case 'function':
      throw new TypeError('Cannot build a cache key from a function');
    default:
      break;
  }
  if (value === null) return 'null';
  const obj = value as object;
  if (
    obj instanceof Map ||
    obj instanceof Set ||
    obj instanceof WeakMap ||
    obj instanceof WeakSet
  ) {
    throw new TypeError(`Cannot build a cache key from a ${obj.constructor.name}`);
  }
  if (ancestors.has(obj)) {
    throw new TypeError('Cannot build a cache key from a circular structure');
  }
  ancestors.add(obj);
  try {
    const toJSON = (obj as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === 'function') {
      return stringifyValue((toJSON as () => unknown).call(obj), ancestors);
    }
    if (Array.isArray(obj)) {
      const items: string[] = [];
      for (let i = 0; i < obj.length; i++) {
        items.push(stringifyValue(obj[i], ancestors));
      }
      return `[${items.join(',')}]`;
    }
    const record = obj as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const v = record[key];
      if (v === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${stringifyValue(v, ancestors)}`);
    }
    return `{${parts.join(',')}}`;
  } finally {
    ancestors.delete(obj);
  }
}

function parseTemplate(template: string): Segment[] {
  const segments: Segment[] = [];
  let literal = '';
  let i = 0;
  while (i < template.length) {
    const ch = template[i] as string;
    if (ch === '{') {
      PLACEHOLDER.lastIndex = i;
      const match = PLACEHOLDER.exec(template);
      if (match === null) {
        throw new CacheConfigError(
          `Invalid cache key template "${template}": malformed placeholder at index ${String(i)}`,
        );
      }
      if (literal !== '') {
        segments.push(literal);
        literal = '';
      }
      const rest = match[2] ?? '';
      segments.push({
        index: Number(match[1]),
        path: rest === '' ? [] : rest.slice(1).split('.'),
      });
      i += match[0].length;
    } else if (ch === '}') {
      throw new CacheConfigError(
        `Invalid cache key template "${template}": unmatched "}" at index ${String(i)}`,
      );
    } else {
      literal += ch;
      i++;
    }
  }
  if (literal !== '') segments.push(literal);
  return segments;
}

/** Percent-encodes `%` first, then `:`, so a rendered argument cannot add a key separator. */
export function escapeKeyArg(value: string): string {
  return value.replaceAll('%', '%25').replaceAll(':', '%3A');
}

function renderValue(value: unknown, escape: boolean): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return escape ? escapeKeyArg(value) : value;
    case 'number':
      return escape ? escapeKeyArg(String(value)) : String(value);
    case 'boolean':
    case 'bigint':
    case 'undefined':
      return String(value);
    default:
      return stableStringify(value);
  }
}

function resolve(args: readonly unknown[], index: number, path: readonly string[]): unknown {
  let current: unknown = args[index];
  for (const prop of path) {
    if (current === null || current === undefined) return undefined;
    current = (Object(current) as Record<string, unknown>)[prop];
  }
  return current;
}

export function compileTemplate(
  template: string,
): (args: readonly unknown[], escape?: boolean) => string {
  const segments = parseTemplate(template);
  return (args, escape = false) => {
    let out = '';
    for (const segment of segments) {
      out +=
        typeof segment === 'string'
          ? segment
          : renderValue(resolve(args, segment.index, segment.path), escape);
    }
    return out;
  };
}

export function defaultKey(
  className: string,
  methodName: string,
  args: readonly unknown[],
): string {
  const base = `${className}.${methodName}`;
  if (args.length === 0) return base;
  const hash = createHash('sha1').update(stableStringify(args)).digest('hex').slice(0, 16);
  return `${base}:${hash}`;
}

/**
 * An empty key is a key error: `fullKey(prefix, namespace, '')` collapses to `prefix:namespace`,
 * which collides with a namespace-less key and is not covered by `clear(namespace)`.
 */
export function isEmptyKey(key: string): boolean {
  return key === '';
}

export function emptyKeyError(): TypeError {
  return new TypeError('Cache key must not be empty');
}

export function fullKey(
  prefix: string | undefined,
  namespace: string | undefined,
  key: string,
): string {
  return [prefix, namespace, key].filter((p): p is string => p !== undefined && p !== '').join(':');
}

/** `<prefix>:__lock__:<namespace>:<key>`; the `__` namespace space is reserved, so it cannot collide with data. */
export function lockKey(
  prefix: string | undefined,
  namespace: string | undefined,
  key: string,
): string {
  return fullKey(prefix, '__lock__', fullKey(undefined, namespace, key));
}

export function isReservedNamespace(ns: string): boolean {
  return ns.startsWith('__');
}

export function namespacePrefix(prefix: string | undefined, namespace: string): string {
  return `${fullKey(prefix, namespace, '')}:`;
}
