import { Logger } from '@nestjs/common';
import type { CacheLogLevel, LogOperation } from '../core/events.js';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const WINDOW_MS = 30_000;

/**
 * @internal The module's logger, provided under `CACHE_LOGGER`. Every library log line that
 * depends on `logging.level` goes through it; nothing is written at `'off'`.
 */
export class CacheLogger {
  private readonly logger = new Logger('CacheModule');

  private readonly throttle = new Map<string, { windowStart: number; suppressed: number }>();

  constructor(readonly level: CacheLogLevel) {}

  /**
   * Logs at most one line per (store, operation) every 30 000 ms; the next line reports how
   * many were suppressed. `error` for delete, clear and tracing, `warn` for every other
   * operation.
   */
  storeError(store: string, operation: LogOperation, error: unknown): void {
    if (this.level === 'off') return;
    const key = `${store}\u0000${operation}`;
    const now = Date.now();
    const entry = this.throttle.get(key);
    if (entry && now - entry.windowStart < WINDOW_MS) {
      entry.suppressed += 1;
      return;
    }
    const suffix =
      entry && entry.suppressed > 0
        ? ` (+${String(entry.suppressed)} similar errors suppressed)`
        : '';
    this.throttle.set(key, { windowStart: now, suppressed: 0 });
    const text = `Cache ${operation} failed on store "${store}": ${messageOf(error)}${suffix}`;
    if (operation === 'delete' || operation === 'clear' || operation === 'tracing') {
      this.logger.error(text);
    } else {
      this.logger.warn(text);
    }
  }

  error(message: string): void {
    if (this.level !== 'off') this.logger.error(message);
  }

  warn(message: string): void {
    if (this.level !== 'off') this.logger.warn(message);
  }

  log(message: string): void {
    if (this.level !== 'off') this.logger.log(message);
  }

  debug(message: string): void {
    if (this.level === 'debug') this.logger.debug(message);
  }
}
