import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import type { CacheEngine, PutOptions } from '../core/cache-engine.js';
import { compileTemplate, defaultKey } from '../core/key-builder.js';
import { strategyOptionsOf } from '../core/strategies/expiry-strategy.js';
import { CacheConfigError } from '../errors.js';
import { engineOf, injectEngine } from './inject-engine.js';
import { addCacheMetadata, describeMethod, type CacheMetadataEntry } from './metadata.js';
import type { KeySpec, StrategyOptions } from './options.js';

export interface MethodCall {
  args: unknown[];
  /** Runs the next layer down (the original method, or the decorator applied below). */
  invoke: () => Promise<unknown>;
  className: string;
  methodName: string;
}

type AnyMethod = (this: unknown, ...args: unknown[]) => unknown;

interface WritePolicy {
  ttl?: number | undefined;
  cacheNull?: boolean | undefined;
  nullTtl?: number | undefined;
  unless?: ((result: never) => boolean) | undefined;
}

const logger = new Logger('CacheModule');
const warned = new Set<string>();

function isEngine(value: unknown): value is CacheEngine {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { getOrSet?: unknown }).getOrSet === 'function'
  );
}

/** Runs `run` and always yields a Promise; a synchronous throw becomes a rejection. */
function settle(run: () => unknown): Promise<unknown> {
  return new Promise((resolve) => {
    resolve(run());
  });
}

function warnOnce(className: string, methodName: string): void {
  const id = `${className}.${methodName}`;
  if (warned.has(id)) return;
  warned.add(id);
  logger.warn(`${id} was called on an instance not created by Nest; caching is skipped.`);
}

/**
 * Rejects a static method. Decorators call it before validating their options, so a static
 * method is reported as such rather than under the misleading name `Function.method`.
 */
export function assertInstanceMethod(target: object, propertyKey: string | symbol): void {
  if (typeof target === 'function') {
    throw new CacheConfigError(
      `${(target as { name: string }).name}.${String(propertyKey)}: cache decorators cannot be used on static methods`,
    );
  }
}

/** Engine write options from decorator options, carrying only the fields that are defined. */
export function putOptionsOf(
  options: (StrategyOptions & WritePolicy) | undefined,
): PutOptions<unknown> {
  if (options === undefined) return {};
  const put: PutOptions<unknown> = strategyOptionsOf(options);
  if (options.ttl !== undefined) put.ttl = options.ttl;
  if (options.cacheNull !== undefined) put.cacheNull = options.cacheNull;
  if (options.nullTtl !== undefined) put.nullTtl = options.nullTtl;
  if (options.unless !== undefined) put.unless = options.unless as (result: unknown) => boolean;
  return put;
}

/**
 * Records the cache metadata, registers engine injection on the prototype and
 * replaces the method with a wrapper that routes calls through `handler`.
 * Stacked decorators each wrap the function produced by the one below.
 */
export function wrapMethod(
  target: object,
  propertyKey: string | symbol,
  descriptor: PropertyDescriptor,
  entry: CacheMetadataEntry,
  handler: (engine: CacheEngine, call: MethodCall) => Promise<unknown>,
): void {
  // Cheap guard for callers that skip their own check; each decorator also asserts first so
  // option validation never masks the static-method message.
  assertInstanceMethod(target, propertyKey);
  const original: unknown = descriptor.value;
  if (typeof original !== 'function') {
    throw new CacheConfigError(
      `${describeMethod(target, propertyKey)}: decorator requires a method`,
    );
  }
  const next = original as AnyMethod;
  addCacheMetadata(target, entry);
  injectEngine(target);
  const className = (target as { constructor: { name: string } }).constructor.name;
  const methodName = String(propertyKey);

  const wrapper = function (this: unknown, ...args: unknown[]): Promise<unknown> {
    const invoke = (): Promise<unknown> => settle(() => next.apply(this, args));
    const engine = engineOf(this);
    if (!isEngine(engine)) {
      warnOnce(className, methodName);
      return invoke();
    }
    return settle(() => handler(engine, { args, invoke, className, methodName }));
  };

  for (const key of Reflect.getMetadataKeys(next) as unknown[]) {
    Reflect.defineMetadata(key, Reflect.getMetadata(key, next), wrapper);
  }
  Object.defineProperty(wrapper, 'name', { value: next.name });
  descriptor.value = wrapper;
}

/** Compiles a key spec at declaration time; a malformed template throws here. */
export function compileKey(spec: KeySpec<never[]> | undefined): (call: MethodCall) => string {
  if (spec === undefined) {
    return (call) => defaultKey(call.className, call.methodName, call.args);
  }
  if (typeof spec === 'string') {
    const render = compileTemplate(spec);
    return (call) => render(call.args);
  }
  const build = spec as (...args: unknown[]) => unknown;
  return (call) => {
    const key = build(...call.args);
    if (typeof key !== 'string') {
      throw new TypeError(`Key callback returned ${typeof key}, expected a string`);
    }
    return key;
  };
}

/** `compileKey` with the declaring class and method named in a template error. */
export function compileKeyAt(
  target: object,
  propertyKey: string | symbol,
  spec: KeySpec<never[]> | undefined,
): (call: MethodCall) => string {
  try {
    return compileKey(spec);
  } catch (error) {
    if (error instanceof CacheConfigError) {
      throw new CacheConfigError(`${describeMethod(target, propertyKey)}: ${error.message}`);
    }
    throw error;
  }
}
