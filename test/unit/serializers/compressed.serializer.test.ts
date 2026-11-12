import { randomBytes } from 'node:crypto';
import { brotliCompressSync, gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { unwrap, wrap } from '../../../src/core/envelope.js';
import { CacheConfigError } from '../../../src/errors.js';
import {
  compressedSerializer,
  OWN_ENVELOPE,
} from '../../../src/serializers/compressed.serializer.js';
import { jsonSerializer, type Serializer } from '../../../src/serializers/json.serializer.js';

const GZ = '\u0000nc1:gz:';
const BR = '\u0000nc1:br:';
const big = () => wrap('a'.repeat(5000), 0, 10);

describe('compressedSerializer', () => {
  it('keeps payloads at or below the threshold as the inner string', () => {
    /* a small payload is stored exactly as jsonSerializer would store it */
    const s = compressedSerializer({ threshold: 10_000 });
    const e = wrap('a'.repeat(100), 0, 10);
    expect(s.serialize(e)).toBe(jsonSerializer.serialize(e));
  });

  it.each([
    ['gzip', GZ],
    ['brotli', BR],
  ] as const)(
    'compresses larger payloads with a %s prefix and round-trips',
    (algorithm, prefix) => {
      /* a compressible payload above the threshold is prefixed, shorter, and decodes back */
      const s = compressedSerializer({ algorithm });
      const out = s.serialize(big());
      expect(out.startsWith(prefix)).toBe(true);
      expect(out.length).toBeLessThan(jsonSerializer.serialize(big()).length);
      expect(unwrap(s.deserialize(out))).toBe('a'.repeat(5000));
    },
  );

  it('stores the inner string when compression is not shorter', () => {
    /* random data does not shrink once base64 and the prefix are added */
    const s = compressedSerializer({ threshold: 100 });
    const e = wrap(randomBytes(3000).toString('base64'), 0, 10);
    expect(s.serialize(e)).toBe(jsonSerializer.serialize(e));
  });

  it('reads uncompressed inner strings', () => {
    /* values written before compression was enabled stay readable */
    const raw = jsonSerializer.serialize(wrap({ a: 1 }, 0, 10));
    expect(unwrap(compressedSerializer().deserialize(raw))).toEqual({ a: 1 });
  });

  it('the threshold counts UTF-8 bytes', () => {
    /* 600 three-byte characters: string length 600+ is below 1024, byte length is above */
    const e = wrap('€'.repeat(400), 0, 10);
    const raw = jsonSerializer.serialize(e);
    expect(raw.length).toBeLessThan(1024);
    expect(Buffer.byteLength(raw, 'utf8')).toBeGreaterThan(1024);
    expect(compressedSerializer().serialize(e).startsWith(GZ)).toBe(true);
  });

  it('the algorithm comes from the prefix', () => {
    /* a brotli value is read by a gzip-configured serializer and the reverse */
    const gz = compressedSerializer({ algorithm: 'gzip' });
    const br = compressedSerializer({ algorithm: 'brotli' });
    expect(unwrap(gz.deserialize(br.serialize(big())))).toBe('a'.repeat(5000));
    expect(unwrap(br.deserialize(gz.serialize(big())))).toBe('a'.repeat(5000));
  });

  it('throws on an unknown algorithm, bad base64, corrupt data and output above maxDecompressedBytes', () => {
    /* every decoding failure is an Error for the engine's deserialize path */
    const s = compressedSerializer({ maxDecompressedBytes: 1000 });
    expect(() => s.deserialize('\u0000nc1:zz:AAAA')).toThrow(Error);
    expect(() => s.deserialize('\u0000nc1:gz:!!!not base64!!!')).toThrow(Error);
    expect(() => s.deserialize(`${GZ}${Buffer.from('garbage').toString('base64')}`)).toThrow(Error);
    expect(() => s.deserialize(`${BR}${Buffer.from('garbage').toString('base64')}`)).toThrow(Error);
    const inner = jsonSerializer.serialize(big());
    for (const [prefix, buf] of [
      [GZ, gzipSync(Buffer.from(inner))],
      [BR, brotliCompressSync(Buffer.from(inner))],
    ] as const) {
      expect(() => s.deserialize(prefix + buf.toString('base64'))).toThrow(
        /ERR_BUFFER_TOO_LARGE|larger than/,
      );
    }
  });

  it('rejects a stray character that only the base64 pattern catches', () => {
    /* Buffer.from skips the stray '*', so without the pattern check this would decode */
    const inner = jsonSerializer.serialize(big());
    const valid = gzipSync(Buffer.from(inner)).toString('base64').replace(/=+$/, '');
    const stray = `${valid.slice(0, 20)}*${valid.slice(20)}`;
    expect(stray.length % 4).not.toBe(1);
    expect(gunzipSync(Buffer.from(stray, 'base64')).toString('utf8')).toBe(inner);
    expect(() => compressedSerializer().deserialize(GZ + stray)).toThrow(/not valid base64/);
  });

  it('keeps a payload whose UTF-8 byte length equals the threshold plain', () => {
    /* the threshold is inclusive: exactly `threshold` bytes is not compressed */
    const e = wrap('a'.repeat(3000), 0, 10);
    const raw = jsonSerializer.serialize(e);
    const threshold = Buffer.byteLength(raw, 'utf8');
    expect(compressedSerializer({ threshold }).serialize(e)).toBe(raw);
    expect(
      compressedSerializer({ threshold: threshold - 1 })
        .serialize(e)
        .startsWith(GZ),
    ).toBe(true);
  });

  it.each(['gzip', 'brotli'] as const)(
    'stores a payload above maxDecompressedBytes plain so it stays readable (%s)',
    (algorithm) => {
      /* a 5000-byte value with a 2048-byte read limit round-trips instead of failing on read */
      const s = compressedSerializer({ algorithm, maxDecompressedBytes: 2048 });
      const out = s.serialize(big());
      expect(unwrap(s.deserialize(out))).toBe('a'.repeat(5000));
      expect(out === jsonSerializer.serialize(big())).toBe(true);
    },
  );

  it('compresses a payload at exactly maxDecompressedBytes', () => {
    /* the read limit is inclusive, so a payload of that size is still compressed and readable */
    const raw = jsonSerializer.serialize(big());
    const s = compressedSerializer({ maxDecompressedBytes: Buffer.byteLength(raw, 'utf8') });
    const out = s.serialize(big());
    expect(out.startsWith(GZ)).toBe(true);
    expect(unwrap(s.deserialize(out))).toBe('a'.repeat(5000));
  });

  it('rejects invalid options with CacheConfigError', () => {
    /* spec 2.1: validated when called */
    const bad = [
      { algorithm: 'zstd' },
      { threshold: -1 },
      { threshold: 1.5 },
      { threshold: Number.NaN },
      { maxDecompressedBytes: 0 },
      { maxDecompressedBytes: 2.5 },
      { inner: {} },
      { inner: { serialize: () => '' } },
    ];
    for (const o of bad) {
      expect(() => compressedSerializer(o as never)).toThrow(CacheConfigError);
    }
    expect(() => compressedSerializer({ threshold: 0 })).not.toThrow();
  });

  it('uses a custom inner serializer', () => {
    /* inner output is what gets sized, compressed and handed back */
    const calls: string[] = [];
    const inner: Serializer = {
      serialize: (e) => {
        calls.push('s');
        return jsonSerializer.serialize(e);
      },
      deserialize: (raw) => {
        calls.push('d');
        return jsonSerializer.deserialize(raw);
      },
    };
    const s = compressedSerializer({ inner });
    expect(unwrap(s.deserialize(s.serialize(big())))).toBe('a'.repeat(5000));
    expect(calls).toEqual(['s', 'd']);
  });

  it('keeps envelope tags through compression', () => {
    /* tags live in the envelope, so they survive the round trip */
    const e = { ...big(), tags: { t: 'abc' } } as ReturnType<typeof big>;
    const s = compressedSerializer();
    const out = s.serialize(e);
    expect(out.startsWith(GZ)).toBe(true);
    expect(s.deserialize(out).tags).toEqual(e.tags);
  });

  it('marks only a wrapper of jsonSerializer with a non-enumerable OWN_ENVELOPE check', () => {
    /* Spec 4: the check says true for an envelope of another version (plain or compressed),
       false for a foreign value, and undefined when it cannot decompress; a custom inner and a
       spread copy carry no marker. */
    const marked = compressedSerializer({ maxDecompressedBytes: 256 }) as unknown as Record<
      typeof OWN_ENVELOPE,
      (raw: string) => boolean | undefined
    >;
    const check = marked[OWN_ENVELOPE];
    expect(check('{"v":1}')).toBe(true);
    expect(check(GZ + gzipSync(Buffer.from('{"v":1}')).toString('base64'))).toBe(true);
    // a newer envelope (v > 1) is ours but is never deleted
    expect(check('{"v":2}')).toBe(false);
    expect(check(GZ + gzipSync(Buffer.from('{"v":2}')).toString('base64'))).toBe(false);
    expect(check(BR + brotliCompressSync(Buffer.from('{"v":"x"}')).toString('base64'))).toBe(true);
    expect(check('{"foo":1}')).toBe(false);
    expect(check('[{"v":1}]')).toBe(false);
    expect(check('not json')).toBe(false);
    expect(check(GZ + gzipSync(Buffer.from('{"foo":1}')).toString('base64'))).toBe(false);
    expect(check(GZ + Buffer.from('garbage').toString('base64'))).toBeUndefined();
    const large = `{"v":2,"value":"${'a'.repeat(500)}"}`;
    expect(check(GZ + gzipSync(Buffer.from(large)).toString('base64'))).toBeUndefined();
    expect(check('\u0000nc1:zz:AAAA')).toBeUndefined();
    const custom: Serializer = {
      serialize: jsonSerializer.serialize,
      deserialize: jsonSerializer.deserialize,
    };
    expect(OWN_ENVELOPE in compressedSerializer({ inner: custom })).toBe(false);
    expect(OWN_ENVELOPE in { ...compressedSerializer() }).toBe(false);
    expect(Object.getOwnPropertySymbols(compressedSerializer())).toEqual([OWN_ENVELOPE]);
  });
});
