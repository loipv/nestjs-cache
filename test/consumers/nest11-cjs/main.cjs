require('reflect-metadata');
const assert = require('node:assert/strict');
const lib = require('@loipv/nestjs-cache');

assert.equal(typeof lib.Cacheable, 'function');
assert.equal(typeof lib.CachePut, 'function');
assert.equal(typeof lib.CacheEvict, 'function');
assert.equal(lib.CACHE_ENGINE, Symbol.for('@loipv/nestjs-cache:engine'));
assert.ok(new lib.CacheConfigError('x') instanceof Error);
console.log('ok');
