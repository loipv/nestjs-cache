import 'reflect-metadata';
import assert from 'node:assert/strict';
import * as lib from '@loipv/nestjs-cache';
import { NestFactory } from '@nestjs/core';
import { Injectable, Module } from '@nestjs/common';

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
Module({ imports: [lib.CacheModule.forRoot({ isGlobal: true })], providers: [UserService] })(
  AppModule,
);
(async () => {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const users = app.get(UserService);
  assert.deepEqual(await users.find('1'), { id: '1' });
  assert.deepEqual(await users.find('1'), { id: '1' });
  assert.equal(users.calls, 1);
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
