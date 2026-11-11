import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import type { CacheEngine, PutOptions } from '../core/cache-engine.js';
import type { TagOption } from '../core/engine-tags.js';
import { compileTemplate, defaultKey, emptyKeyError, isEmptyKey } from '../core/key-builder.js';
import {
  createStrategy,
  strategyOptionsOf,
  type ExpiryStrategy,
} from '../core/strategies/expiry-strategy.js';
import { CacheConfigError } from '../errors.js';
import { engineOf, injectEngine } from './inject-engine.js';
import {
  addCacheMetadata,
  assertTags,
  describeMethod,
  type CacheMetadataEntry,
} from './metadata.js';
import type { KeySpec, LoadStrategyOptions } from './options.js';

export interface MethodCall {
  args: unknown[];
  /** Runs the next layer down (the original method, or the decorator applied below). */
  invoke: () => Promise<unknown>;
  className: string;
  methodName: string;
  /** The engine's `escapeKeyArgs`: template keys percent-encode `%` and `:` in arguments. */
  escapeKeyArgs: boolean;
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
  options: (LoadStrategyOptions & WritePolicy) | undefined,
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
 * Builds the strategy of fixed decorator options once, at decoration time. Options that
 * `createStrategy` rejects yield `undefined`, so the engine still rejects each call with its
 * usual message, as before.
 */
export function presetStrategy(options: LoadStrategyOptions): ExpiryStrategy | undefined {
  try {
    return createStrategy(options);
  } catch {
    return undefined;
  }
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
    return settle(() =>
      handler(engine, {
        args,
        invoke,
        className,
        methodName,
        escapeKeyArgs: engine.escapeKeyArgs,
      }),
    );
  };

  for (const key of Reflect.getMetadataKeys(next) as unknown[]) {
    Reflect.defineMetadata(key, Reflect.getMetadata(key, next), wrapper);
  }
  Object.defineProperty(wrapper, 'name', { value: next.name });
  descriptor.value = wrapper;
}

/**
 * Compiles a key spec at declaration time; a malformed template throws here. The built
 * function throws for a key that cannot be built and, unless `allowEmpty` is set, for one
 * that renders empty. `@CacheEvict` allows it: the engine drops empty keys from a delete.
 */
export function compileKey(
  spec: KeySpec<never[]> | undefined,
  allowEmpty = false,
): (call: MethodCall) => string {
  const build = compileRawKey(spec);
  if (allowEmpty) return build;
  return (call) => {
    const key = build(call);
    if (isEmptyKey(key)) throw emptyKeyError();
    return key;
  };
}

function compileRawKey(spec: KeySpec<never[]> | undefined): (call: MethodCall) => string {
  if (spec === undefined) {
    return (call) => defaultKey(call.className, call.methodName, call.args);
  }
  if (typeof spec === 'string') {
    const render = compileTemplate(spec);
    return (call) => render(call.args, call.escapeKeyArgs);
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

/** Runs a declaration-time compile with the declaring class and method named in its error. */
function compileAt<T>(target: object, propertyKey: string | symbol, compile: () => T): T {
  try {
    return compile();
  } catch (error) {
    if (error instanceof CacheConfigError) {
      throw new CacheConfigError(`${describeMethod(target, propertyKey)}: ${error.message}`);
    }
    throw error;
  }
}

/** `compileKey` with the declaring class and method named in a template error. */
export function compileKeyAt(
  target: object,
  propertyKey: string | symbol,
  spec: KeySpec<never[]> | undefined,
  allowEmpty = false,
): (call: MethodCall) => string {
  return compileAt(target, propertyKey, () => compileKey(spec, allowEmpty));
}

/**
 * Validates a tags array at declaration time (spec 2.5) and compiles its templates, naming the
 * declaring method in an error. The built function renders every template against the call's
 * arguments (escaped as template keys are, with `escapeKeyArgs`); it throws for an argument that
 * cannot be rendered.
 */
function compileTagTemplates(
  target: object,
  propertyKey: string | symbol,
  tags: readonly string[],
): (call: MethodCall) => string[] {
  const renders = compileAt(target, propertyKey, () => tags.map((tag) => compileTemplate(tag)));
  return (call) => renders.map((render) => render(call.args, call.escapeKeyArgs));
}

/**
 * Compiles the `tags` of `@Cacheable` or `@CachePut` (spec 2.1) into the engine tags of a call
 * (D2): a template array becomes the array rendered from the call's arguments, so its tokens are
 * taken before the method runs; a callback `(result, ...args)` becomes a function of the value.
 * `undefined` when no tag is declared (an empty array included). The built function never
 * throws: an argument a template cannot render gives a function that throws, so the write is
 * skipped and reported as a `tag` error, as for a callback that throws.
 */
export function compileTags(
  target: object,
  propertyKey: string | symbol,
  spec: unknown,
): ((call: MethodCall) => TagOption<unknown>) | undefined {
  assertTags(target, propertyKey, spec);
  if (spec === undefined) return undefined;
  if (typeof spec === 'function') {
    const callback = spec as (result: unknown, ...args: unknown[]) => readonly string[];
    return (call) => (value) => callback(value, ...call.args);
  }
  const tags = spec as readonly string[];
  if (tags.length === 0) return undefined;
  const render = compileTagTemplates(target, propertyKey, tags);
  return (call) => {
    try {
      return render(call);
    } catch (error) {
      return () => {
        throw error;
      };
    }
  };
}

/**
 * Compiles the `tags` of `@CacheEvict` (spec 2.2): a template array rendered from the call's
 * arguments, or a callback of the arguments, whose result is returned unchecked. An empty array
 * is rejected, as an empty key list is.
 */
export function compileEvictTags(
  target: object,
  propertyKey: string | symbol,
  spec: unknown,
): ((call: MethodCall) => unknown) | undefined {
  assertTags(target, propertyKey, spec);
  if (spec === undefined) return undefined;
  if (typeof spec === 'function') {
    const callback = spec as (...args: unknown[]) => unknown;
    return (call) => callback(...call.args);
  }
  const tags = spec as readonly string[];
  if (tags.length === 0) {
    throw new CacheConfigError(
      `${describeMethod(target, propertyKey)}: tags must not be an empty array`,
    );
  }
  return compileTagTemplates(target, propertyKey, tags);
}
