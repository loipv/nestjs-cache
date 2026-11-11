import { describe, it, expect } from 'vitest';
import { httpCacheKey, parseHttpUrl } from '../../../src/http/http-cache-key.js';

describe('httpCacheKey', () => {
  it('sorts query pairs by name then value', () => {
    /* /users?b=2&a=1&a=0 normalises to /users?a=0&a=1&b=2 */
    expect(httpCacheKey('/users?b=2&a=1&a=0')).toBe('/users?a=0&a=1&b=2');
  });

  it('drops an empty query', () => {
    /* a bare ? and no query both give the plain path */
    expect(httpCacheKey('/users?')).toBe('/users');
    expect(httpCacheKey('/users')).toBe('/users');
  });

  it('percent-encodes % and : in the whole key', () => {
    /* colons and percents in path or query never reach the key raw */
    expect(httpCacheKey('/a:b')).toBe('/a%3Ab');
    expect(httpCacheKey('/a?x=1:2')).toBe('/a?x=1%253A2');
    expect(httpCacheKey('/p%20q')).toContain('%2520');
  });

  it('treats + and %20 in the query the same', () => {
    /* both spell a space in a query string */
    expect(httpCacheKey('/s?q=a+b')).toBe(httpCacheKey('/s?q=a%20b'));
  });

  it('keeps unicode stable', () => {
    /* raw and percent-encoded unicode give one key */
    expect(httpCacheKey('/s?q=日本')).toBe(httpCacheKey('/s?q=%E6%97%A5%E6%9C%AC'));
  });
});

describe('parseHttpUrl', () => {
  it('groups repeated names', () => {
    /* a name seen once is a string, several times an array in input order */
    expect(parseHttpUrl('/x?a=1&b=2&a=3')).toEqual({
      path: '/x',
      query: { a: ['1', '3'], b: '2' },
    });
  });
});
