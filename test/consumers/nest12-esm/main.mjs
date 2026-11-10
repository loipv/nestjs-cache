import 'reflect-metadata';
import assert from 'node:assert/strict';
import * as lib from '@loipv/nestjs-cache';

assert.equal(typeof lib.Cacheable, 'function');
assert.equal(typeof lib.CachePut, 'function');
assert.equal(typeof lib.CacheEvict, 'function');
assert.equal(lib.CACHE_ENGINE, Symbol.for('@loipv/nestjs-cache:engine'));
assert.ok(new lib.CacheConfigError('x') instanceof Error);
console.log('ok');
