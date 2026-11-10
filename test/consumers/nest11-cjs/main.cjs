require('reflect-metadata');
const assert = require('node:assert/strict');
const lib = require('@loipv/nestjs-cache');
const promClient = require('prom-client');
const { NestFactory } = require('@nestjs/core');
const { Injectable, Module } = require('@nestjs/common');

assert.equal(typeof lib.Cacheable, 'function');
assert.equal(typeof lib.CachePut, 'function');
assert.equal(typeof lib.CacheEvict, 'function');
assert.equal(lib.CACHE_ENGINE, Symbol.for('@loipv/nestjs-cache:engine'));
assert.ok(new lib.CacheConfigError('x') instanceof Error);

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
    lib.CacheModule.forRoot({ isGlobal: true }),
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
  await app.close();
  console.log('ok');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
