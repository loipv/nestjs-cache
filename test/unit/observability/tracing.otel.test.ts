import 'reflect-metadata';
import {
  context,
  isSpanContextValid,
  trace,
  type Span,
  type SpanOptions,
  type Tracer,
} from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import {
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  type INestApplication,
  type ModuleMetadata,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CacheService } from '../../../src/core/cache.service.js';
import { Cacheable } from '../../../src/decorators/cacheable.js';
import { HttpCache } from '../../../src/http/http-cache.decorator.js';
import type { CacheLogger } from '../../../src/module/cache.logger.js';
import { CacheModule } from '../../../src/module/cache.module.js';
import { CACHE_LOGGER } from '../../../src/module/tokens.js';
import { CacheTracingModule } from '../../../src/observability/tracing.module.js';

const TRACER = Symbol('tracer');

/** The parts of an Express request and response the request-span middleware uses. */
interface MiddlewareRequest {
  method: string;
  path: string;
}
interface MiddlewareResponse {
  on(event: 'finish', listener: () => void): unknown;
}

/** Starts a `user.work` span under the active one (after an `await`), as user code would. */
async function userWork<T>(tracer: Tracer, value: T): Promise<T> {
  await new Promise((resolve) => setImmediate(resolve));
  return tracer.startActiveSpan('user.work', async (span) => {
    await Promise.resolve();
    span.end();
    return value;
  });
}

@Injectable()
class Users {
  constructor(@Inject(TRACER) private readonly tracer: Tracer) {}

  @Cacheable({ namespace: 'users', key: 'u:{0}' })
  find(id: string): Promise<string> {
    return userWork(this.tracer, `user ${id}`);
  }
}

@Controller()
class ItemsController {
  constructor(@Inject(TRACER) private readonly tracer: Tracer) {}

  @Get('items')
  @HttpCache({ ttl: 60_000 })
  list(): Promise<{ n: number }> {
    return userWork(this.tracer, { n: 1 });
  }
}

describe('tracing with the OpenTelemetry SDK', () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  let tracer: Tracer;
  let ref: TestingModule | undefined;
  let app: INestApplication | undefined;

  beforeAll(() => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    trace.setGlobalTracerProvider(provider);
    tracer = trace.getTracer('nestjs-cache-test');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await ref?.close();
    ref = undefined;
    await app?.close();
    app = undefined;
    exporter.reset();
  });

  afterAll(async () => {
    await provider.shutdown();
    trace.disable();
    context.disable();
  });

  function imports(): ModuleMetadata['imports'] {
    return [CacheModule.forRoot({ isGlobal: true }), CacheTracingModule.forRoot({ tracer })];
  }

  async function finished(): Promise<ReadableSpan[]> {
    await provider.forceFlush();
    return exporter.getFinishedSpans();
  }

  function one(spans: ReadableSpan[], name: string): ReadableSpan {
    const found = spans.filter((s) => s.name === name);
    expect(found, name).toHaveLength(1);
    return found[0]!;
  }

  /** Asserts `user.work` → `cache.load` → `cache.getOrSet` → `outer`, all in one trace. */
  function expectChain(spans: ReadableSpan[], outer: string): void {
    const chain = ['user.work', 'cache.load', 'cache.getOrSet', outer].map((n) => one(spans, n));
    for (let i = 0; i < chain.length - 1; i += 1) {
      const child = chain[i]!;
      const parent = chain[i + 1]!;
      expect(child.parentSpanContext?.spanId, `${child.name} parent`).toBe(
        parent.spanContext().spanId,
      );
      expect(child.spanContext().traceId).toBe(parent.spanContext().traceId);
    }
    expect(chain[3]!.parentSpanContext).toBeUndefined();
  }

  async function compile(): Promise<TestingModule> {
    ref = await Test.createTestingModule({
      imports: imports(),
      providers: [Users, { provide: TRACER, useValue: tracer }],
    }).compile();
    await ref.init();
    return ref;
  }

  it('nests through @Cacheable', async () => {
    const users = (await compile()).get(Users);
    const value = await tracer.startActiveSpan('request', async (span) => {
      const found = await users.find('1');
      span.end();
      return found;
    });
    expect(value).toBe('user 1');
    const spans = await finished();
    expectChain(spans, 'request');
    expect(one(spans, 'cache.getOrSet').attributes).toEqual({
      'cache.store': 'default',
      'cache.namespace': 'users',
      'cache.result': 'miss',
    });
  });

  it('nests through CacheService.getOrSet', async () => {
    const cache = (await compile()).get(CacheService);
    const value = await tracer.startActiveSpan('request', async (span) => {
      const loaded = await cache.getOrSet('k', () => userWork(tracer, 42));
      span.end();
      return loaded;
    });
    expect(value).toBe(42);
    expectChain(await finished(), 'request');
  });

  it('nests through @HttpCache on Express under the request span', async () => {
    /* A span the test starts around `fetch` does not cross the HTTP server boundary: the
       server handles the connection in its own async context. So an Express middleware starts
       the request span and runs the rest of the pipeline in it, as HTTP instrumentation does. */
    @Module({
      imports: imports(),
      controllers: [ItemsController],
      providers: [{ provide: TRACER, useValue: tracer }],
    })
    class AppModule {}
    const created = await NestFactory.create(AppModule, new ExpressAdapter(), { logger: false });
    app = created;
    created.use((req: MiddlewareRequest, res: MiddlewareResponse, next: () => void) => {
      tracer.startActiveSpan(`${req.method} ${req.path}`, (span) => {
        res.on('finish', () => {
          span.end();
        });
        next();
      });
    });
    await created.init();
    await created.listen(0, '127.0.0.1');
    const base = (await created.getUrl()).replace('[::1]', '127.0.0.1');

    const outside = await tracer.startActiveSpan('client', async (span) => {
      const res = await fetch(`${base}/items`);
      span.end();
      return (await res.json()) as unknown;
    });
    expect(outside).toEqual({ n: 1 });

    await vi.waitFor(async () => {
      expect((await finished()).map((s) => s.name)).toContain('GET /items');
    });
    const spans = await finished();
    expectChain(spans, 'GET /items');
    // The client span is in another trace: context does not cross the HTTP boundary in-process.
    expect(one(spans, 'cache.getOrSet').spanContext().traceId).not.toBe(
      one(spans, 'client').spanContext().traceId,
    );
  });
});

describe('tracing with the OpenTelemetry API and no SDK registered', () => {
  interface Run {
    results: unknown[];
    loads: number;
    errors: unknown[];
    tracingErrors: number;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /** A fixed scenario: miss, hit, failing load, batch, writes, then a swr refresh. */
  async function scenario(traced: Tracer | undefined): Promise<Run> {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(0);
    const metadata: ModuleMetadata = {
      imports: [
        CacheModule.forRoot({ isGlobal: true }),
        ...(traced === undefined ? [] : [CacheTracingModule.forRoot({ tracer: traced })]),
      ],
    };
    const ref = await Test.createTestingModule(metadata).compile();
    await ref.init();
    const cache = ref.get(CacheService);
    const logger = ref.get<CacheLogger>(CACHE_LOGGER);
    const storeError = vi.spyOn(logger, 'storeError');
    let loads = 0;
    const load = <T>(value: T) => {
      return async (): Promise<T> => {
        loads += 1;
        await Promise.resolve();
        return value;
      };
    };
    const results: unknown[] = [];
    const errors: unknown[] = [];
    try {
      results.push(await cache.getOrSet('a', load(1)));
      results.push(await cache.getOrSet('a', load(2)));
      await cache
        .getOrSet('bad', () => Promise.reject(new Error('load failed')))
        .catch((error: unknown) => errors.push((error as Error).message));
      results.push(
        await cache.getOrSetMany(['a', 'b'], (missing) =>
          load(new Map(missing.map((k) => [k, `${k}!`])))(),
        ),
      );
      await cache.set('c', 'v');
      results.push(await cache.get('c'), await cache.getMany(['a', 'c', 'z']));
      await cache.delete('c');
      results.push(await cache.get('c'));

      const swr = { ttl: 100, strategy: 'swr', staleTtl: 300 } as const;
      results.push(await cache.getOrSet('s', load('old'), swr));
      vi.setSystemTime(150);
      results.push(await cache.getOrSet('s', load('new'), swr));
      await vi.waitFor(async () => {
        expect(await cache.get('s', swr)).toBe('new');
      });
      results.push(await cache.getOrSet('s', load('newer'), swr));
    } finally {
      await ref.close();
    }
    const tracingErrors = storeError.mock.calls.filter((call) => call[1] === 'tracing').length;
    return { results, loads, errors, tracingErrors };
  }

  it('has no SDK registered: spans do not record and their context is invalid', () => {
    const probe = trace.getTracer('x').startSpan('probe');
    expect(probe.isRecording()).toBe(false);
    expect(isSpanContextValid(probe.spanContext())).toBe(false);
    probe.end();
  });

  it('behaves as without tracing, including a swr refresh linked to an invalid context', async () => {
    const tracer = trace.getTracer('x');
    const started: { name: string; options: SpanOptions }[] = [];
    const startActiveSpan = tracer.startActiveSpan.bind(tracer) as (
      name: string,
      options: SpanOptions,
      fn: (span: Span) => unknown,
    ) => unknown;
    vi.spyOn(tracer, 'startActiveSpan').mockImplementation(((
      name: string,
      options: SpanOptions,
      fn: (span: Span) => unknown,
    ) => {
      started.push({ name, options });
      return startActiveSpan(name, options, fn);
    }) as Tracer['startActiveSpan']);

    const untraced = await scenario(undefined);
    const traced = await scenario(tracer);

    expect(traced).toEqual(untraced);
    expect(untraced).toMatchObject({
      loads: 4,
      errors: ['load failed'],
      tracingErrors: 0,
    });
    expect(untraced.results).toEqual([
      1,
      1,
      [1, 'b!'],
      'v',
      [1, 'v', undefined],
      undefined,
      'old',
      'old',
      'new',
    ]);

    const refresh = started.filter((s) => s.name === 'cache.refresh');
    expect(refresh).toHaveLength(1);
    expect(refresh[0]!.options.root).toBe(true);
    const links = refresh[0]!.options.links ?? [];
    expect(links).toHaveLength(1);
    expect(isSpanContextValid(links[0]!.context)).toBe(false);
    expect(started.map((s) => s.name)).toContain('cache.getOrSet');
  });
});
