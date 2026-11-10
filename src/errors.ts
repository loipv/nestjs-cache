/**
 * Thrown for invalid configuration: bad decorator or module options, an unknown store name, or
 * an invalid per-call argument.
 */
export class CacheConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CacheConfigError';
  }

  /**
   * The ESM and CommonJS builds each define this class, so `instanceof` also accepts any `Error`
   * named `CacheConfigError`. Subclasses keep the normal prototype check.
   */
  static override [Symbol.hasInstance](value: unknown): boolean {
    if (Function.prototype[Symbol.hasInstance].call(this, value)) return true;
    return this === CacheConfigError && value instanceof Error && value.name === 'CacheConfigError';
  }
}
