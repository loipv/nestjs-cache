// Boots the app on a random port, calls its routes with `fetch` and checks the cache behaviour.
// Prints `SMOKE OK` on success and exits 1 on any failed check.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import net from 'node:net';
import { NestFactory } from '@nestjs/core';
import { createAppModule } from './app.module.js';

// Record the target of every outbound socket connection, from here on.
const targets: string[] = [];
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]): net.Socket {
  // `net.connect` hands `Socket#connect` its arguments normalized to `[options, callback]`.
  const first: unknown = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
  if (typeof first === 'object' && first !== null) {
    const o = first as { host?: string; port?: number; path?: string };
    targets.push(o.path ?? `${o.host ?? 'localhost'}:${String(o.port)}`);
  } else if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    targets.push(`${typeof args[1] === 'string' ? args[1] : 'localhost'}:${String(first)}`);
  } else {
    targets.push(String(first)); // an IPC path
  }
  return (originalConnect as (...a: unknown[]) => net.Socket).apply(this, args);
} as typeof net.Socket.prototype.connect;

const withRedis = Boolean(process.env['REDIS_URL']);
const app = await NestFactory.create(createAppModule(process.env), { logger: ['error'] });

try {
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address() as net.AddressInfo;
  const base = `http://127.0.0.1:${String(address.port)}`;

  const get = async (path: string): Promise<unknown> => {
    const res = await fetch(base + path);
    assert.equal(res.status, 200, `GET ${path} -> ${String(res.status)}`);
    return res.json();
  };
  const stats = () => get('/stats') as Promise<{ loads: number; catalogRuns: number }>;

  // With Redis the keys outlive a previous run, so count from the current counters.
  const start = await stats();
  const loadsFor = async () => (await stats()).loads - start.loads;
  const runsFor = async () => (await stats()).catalogRuns - start.catalogRuns;

  // @Cacheable: a miss, then a hit.
  assert.deepEqual(await get('/products/1'), { id: '1', name: 'Keyboard' });
  const loadsAfterFirst = await loadsFor();
  assert.deepEqual(await get('/products/1'), { id: '1', name: 'Keyboard' });
  assert.equal(await loadsFor(), loadsAfterFirst, 'second GET /products/1 must be a cache hit');
  await get('/products/2');

  // @HttpCache: the handler runs once, the second GET is served from the cache.
  await get('/catalog');
  const runsAfterFirst = await runsFor();
  await get('/catalog');
  assert.equal(await runsFor(), runsAfterFirst, 'second GET /catalog must be a cache hit');

  // @CacheEvict({ tags }): product 1 and the catalog are evicted; product 2 stays cached.
  const loadsBefore = await loadsFor();
  const res = await fetch(`${base}/products/1`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Mechanical keyboard' }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await get('/products/1'), { id: '1', name: 'Mechanical keyboard' });
  assert.equal(await loadsFor(), loadsBefore + 1, 'GET /products/1 after eviction must reload');
  await get('/products/2');
  assert.equal(await loadsFor(), loadsBefore + 1, 'product 2 must stay cached');
  await get('/catalog');
  assert.equal(await runsFor(), runsAfterFirst + 1, 'GET /catalog after eviction must run again');
  await get('/catalog');
  assert.equal(await runsFor(), runsAfterFirst + 1, 'GET /catalog is cached again');

  // No Redis configured: the only connections are the fetch calls to the app's own server.
  if (!withRedis) {
    assert.ok(targets.length > 0, 'the connection spy saw nothing, so it proves nothing');
    const own = `127.0.0.1:${String(address.port)}`;
    const foreign = targets.filter((t) => t !== own);
    assert.deepEqual(foreign, [], `unexpected outbound connections: ${foreign.join(', ')}`);
    console.log(`outbound connections: ${String(targets.length)}, all to ${own}`);
  }
  console.log('SMOKE OK');
} catch (error) {
  console.error('SMOKE FAILED', error);
  process.exitCode = 1;
} finally {
  await app.close();
}
