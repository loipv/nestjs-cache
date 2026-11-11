import 'reflect-metadata';
import assert from 'node:assert/strict';
import * as lib from '@loipv/nestjs-cache';
import * as promClient from '@prometheus-io/client';
import { createClient } from 'redis';
import { NestFactory } from '@nestjs/core';
import { Injectable, Module } from '@nestjs/common';

assert.equal(typeof lib.Cacheable, 'function');
assert.equal(typeof lib.CachePut, 'function');
assert.equal(typeof lib.CacheEvict, 'function');
// The DI tokens are internal (0.9): the package index does not export them.
assert.equal(lib.CACHE_ENGINE, undefined);
assert.ok(new lib.CacheConfigError('x') instanceof Error);
// node-redis v5 client: the adapter is built without connecting.
assert.equal(typeof lib.nodeRedisAdapter(createClient()).createSubscriber, 'function');

class UserService {
  calls = 0;
  async find(id) {
    this.calls += 1;
    return { id };
  }
  swrCalls = 0;
  async findSwr(id) {
    this.swrCalls += 1;
    return { id };
  }
}
const descriptor = Object.getOwnPropertyDescriptor(UserService.prototype, 'find');
lib.Cacheable({ namespace: 'users', key: 'user:{0}' })(UserService.prototype, 'find', descriptor);
Object.defineProperty(UserService.prototype, 'find', descriptor);
const swrDescriptor = Object.getOwnPropertyDescriptor(UserService.prototype, 'findSwr');
lib.Cacheable({ namespace: 'users', key: 'swr:{0}', strategy: 'swr', staleTtl: 60_000 })(
  UserService.prototype,
  'findSwr',
  swrDescriptor,
);
Object.defineProperty(UserService.prototype, 'findSwr', swrDescriptor);
Injectable()(UserService);
class AppModule {}
const registry = new promClient.Registry();
Module({
  imports: [
    lib.CacheModule.forRoot({ isGlobal: true, namespaces: { users: { versioned: true } } }),
    lib.CachePrometheusModule.forRoot({ client: promClient, registry }),
  ],
  providers: [UserService],
})(AppModule);
(async () => {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const users = app.get(UserService);
  assert.deepEqual(await users.find('1'), { id: '1' });
  assert.deepEqual(await users.find('1'), { id: '1' });
  assert.equal(users.calls, 1);
  // Read the counter through the client API, so label order does not matter.
  const requests = await registry.getSingleMetric('cache_requests_total').get();
  const hit = requests.values.find(
    (v) =>
      v.labels.store === 'default' && v.labels.namespace === 'users' && v.labels.result === 'hit',
  );
  assert.equal(hit?.value, 1);
  assert.deepEqual(await users.findSwr('1'), { id: '1' });
  assert.deepEqual(await users.findSwr('1'), { id: '1' });
  assert.equal(users.swrCalls, 1);
  assert.equal(
    (await app.get(lib.CacheService).get('user:1', { namespace: 'users' })) !== undefined,
    true,
  );
  // Versioned namespace and batch API.
  const cache = app.get(lib.CacheService);
  let batchCalls = 0;
  const loadUsers = async (missing) => {
    batchCalls += 1;
    return new Map(missing.map((id) => [id, { id }]));
  };
  const batch = await cache.getOrSetMany(['1', '2'], loadUsers, { namespace: 'users' });
  assert.deepEqual(batch, [{ id: '1' }, { id: '2' }]);
  assert.equal(batchCalls, 1);
  await cache.getOrSetMany(['1', '2'], loadUsers, { namespace: 'users' });
  assert.equal(batchCalls, 1);
  await cache.clear('users');
  await cache.getOrSetMany(['1', '2'], loadUsers, { namespace: 'users' });
  assert.equal(batchCalls, 2);
  await app.close();
  console.log('ok');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
