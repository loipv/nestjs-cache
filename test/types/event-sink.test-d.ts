import type { CacheEventSink, CacheLogLevel } from '../../src/index.js';
// A hand-built sink without logLevel is still a CacheEventSink (spec 2.3: additive change).
export const plain: CacheEventSink = { emit() {} };
export const leveled: CacheEventSink = { emit() {}, logLevel: 'off' };
export const level: CacheLogLevel | undefined = plain.logLevel;
// @ts-expect-error logLevel only accepts a CacheLogLevel
export const badLevel: CacheEventSink = { emit() {}, logLevel: 'warn' };
