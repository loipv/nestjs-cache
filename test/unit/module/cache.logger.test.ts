import 'reflect-metadata';
import { ConsoleLogger, Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { CacheService } from '../../../src/core/cache.service.js';
import { CacheLogger } from '../../../src/module/cache.logger.js';
import { CacheModule } from '../../../src/module/cache.module.js';

// This file must not use `@nestjs/testing`: compiling a TestingModule replaces the static Nest
// logger with a TestingLogger, and the assumption 3 test needs the untouched default logger.

describe('CacheLogger', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function spies(): Record<'error' | 'warn' | 'log' | 'debug', MockInstance> {
    return {
      error: vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined),
      warn: vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined),
      log: vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined),
      debug: vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined),
    };
  }

  it('exposes its level', () => {
    expect(new CacheLogger('debug').level).toBe('debug');
  });

  it('throttles store errors per (store, operation) over 30 s, with the 0.2 strings', () => {
    vi.useFakeTimers();
    const s = spies();
    const logger = new CacheLogger('error');
    for (let i = 0; i < 3; i++) logger.storeError('default', 'get', new Error('down'));
    logger.storeError('default', 'metrics', new Error('bad label'));
    logger.storeError('default', 'delete', 'plain');
    expect(s.warn.mock.calls).toEqual([
      ['Cache get failed on store "default": down'],
      ['Cache metrics failed on store "default": bad label'],
    ]);
    expect(s.error.mock.calls).toEqual([['Cache delete failed on store "default": plain']]);
    vi.advanceTimersByTime(30_000);
    logger.storeError('default', 'get', new Error('down'));
    expect(s.warn).toHaveBeenLastCalledWith(
      'Cache get failed on store "default": down (+2 similar errors suppressed)',
    );
  });

  it("'error' writes error, warn and log but not debug", () => {
    const s = spies();
    const logger = new CacheLogger('error');
    logger.error('e');
    logger.warn('w');
    logger.log('l');
    logger.debug('d');
    expect(s.error).toHaveBeenCalledExactlyOnceWith('e');
    expect(s.warn).toHaveBeenCalledExactlyOnceWith('w');
    expect(s.log).toHaveBeenCalledExactlyOnceWith('l');
    expect(s.debug).not.toHaveBeenCalled();
  });

  it("'debug' also writes debug", () => {
    const s = spies();
    new CacheLogger('debug').debug('d');
    expect(s.debug).toHaveBeenCalledExactlyOnceWith('d');
  });

  it("'off' writes nothing", () => {
    const s = spies();
    const logger = new CacheLogger('off');
    logger.storeError('default', 'get', new Error('down'));
    logger.storeError('default', 'clear', new Error('down'));
    logger.error('e');
    logger.warn('w');
    logger.log('l');
    logger.debug('d');
    for (const spy of Object.values(s)) expect(spy).not.toHaveBeenCalled();
  });
});

describe('default Nest logger (assumption 3)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Logger.debug prints with the default Nest logger (giả định 3)', async () => {
    /* NestFactory.createApplicationContext(AppModule với logging debug) không truyền logger; spy process.stdout.write; cache.get → có dòng chứa 'Cache miss' */
    // Nothing in this file overrides the static logger: the line must come from Nest's own
    // ConsoleLogger (spied here with call-through, so it still prints).
    const consoleDebug = vi.spyOn(ConsoleLogger.prototype, 'debug');
    const savedLevel = process.env.NEST_LOG_LEVEL;
    delete process.env.NEST_LOG_LEVEL;
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    });
    @Module({ imports: [CacheModule.forRoot({ logging: { level: 'debug' } })] })
    class AppModule {}
    const app = await NestFactory.createApplicationContext(AppModule);
    try {
      await app.get(CacheService).get('k', { namespace: 'users' });
    } finally {
      await app.close();
      if (savedLevel !== undefined) process.env.NEST_LOG_LEVEL = savedLevel;
    }
    vi.mocked(process.stdout.write).mockRestore();
    const line = written.find((chunk) => chunk.includes('Cache miss default users:k'));
    expect(line).toBeDefined();
    expect(line).toContain('DEBUG');
    expect(line).toContain('[CacheModule]');
    expect(consoleDebug).toHaveBeenCalledWith(
      expect.stringContaining('Cache miss default users:k'),
      'CacheModule',
    );
  });
});
