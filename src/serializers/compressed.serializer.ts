import {
  brotliCompressSync,
  brotliDecompressSync,
  constants,
  gunzipSync,
  gzipSync,
} from 'node:zlib';
import { CacheConfigError } from '../errors.js';
import { hasOwnVersion, isNewerEnvelope, type CacheEnvelope } from '../core/envelope.js';
import { jsonSerializer, type Serializer } from './json.serializer.js';

/** Options of `compressedSerializer`. */
export interface CompressedSerializerOptions {
  /** Produces and reads the string that gets compressed. Default `jsonSerializer`. */
  inner?: Serializer;
  /** Algorithm used for writes; reads follow the prefix of the stored value. Default `'gzip'`. */
  algorithm?: 'gzip' | 'brotli';
  /**
   * Compression level: 0-9 for gzip (default 6, zlib's default) and 0-11 for brotli (default 4).
   * Compression runs synchronously on the event loop. Brotli's own default, 11, is much slower:
   * about 1.6 s for a 724 KB JSON value, against about 2 ms at 4. Reads accept any level.
   */
  level?: number;
  /** UTF-8 byte length of the inner string above which compression is tried. Default 1024. */
  threshold?: number;
  /**
   * Upper bound of a decompressed payload, in bytes. Default 16 MiB. Larger payloads are written
   * uncompressed so they stay readable.
   */
  maxDecompressedBytes?: number;
}

/**
 * Internal (not exported from the package): the key of the check `compressedSerializer` adds
 * over `jsonSerializer`, which tells the engine whether an unreadable raw string is one of the
 * library's own envelopes, ours and deletable (a newer `v` is kept) (spec 4). The check returns
 * `undefined` when it cannot tell.
 */
export const OWN_ENVELOPE: unique symbol = Symbol('nestjs-cache.ownEnvelope');

const DETECT = '\u0000nc1:';
const PREFIXES = { gzip: `${DETECT}gz:`, brotli: `${DETECT}br:` } as const;

/**
 * Wraps a serializer with gzip or brotli compression of large payloads. A compressed value is
 * `"\u0000nc1:gz:"` or `"\u0000nc1:br:"` plus base64; anything else is read by `inner`.
 * `inner` must not produce strings starting with `"\u0000nc1:"`.
 */
export function compressedSerializer(options: CompressedSerializerOptions = {}): Serializer {
  const {
    inner: suppliedInner = jsonSerializer,
    threshold = 1024,
    maxDecompressedBytes = 16 * 1024 * 1024,
  } = options;
  // Runtime values can be anything: validate against the widest types.
  const algorithm: string = options.algorithm ?? 'gzip';
  const inner = suppliedInner as Partial<Serializer> | null;
  if (algorithm !== 'gzip' && algorithm !== 'brotli') {
    throw new CacheConfigError("compressedSerializer: algorithm must be 'gzip' or 'brotli'");
  }
  const maxLevel = algorithm === 'gzip' ? 9 : 11;
  const level: unknown = options.level ?? (algorithm === 'gzip' ? 6 : 4);
  if (typeof level !== 'number' || !Number.isInteger(level) || level < 0 || level > maxLevel) {
    throw new CacheConfigError(
      `compressedSerializer: level must be an integer from 0 to ${String(maxLevel)} for ${algorithm}`,
    );
  }
  if (!Number.isInteger(threshold) || threshold < 0) {
    throw new CacheConfigError('compressedSerializer: threshold must be an integer >= 0');
  }
  if (!Number.isInteger(maxDecompressedBytes) || maxDecompressedBytes <= 0) {
    throw new CacheConfigError('compressedSerializer: maxDecompressedBytes must be an integer > 0');
  }
  if (
    typeof inner !== 'object' ||
    inner === null ||
    typeof inner.serialize !== 'function' ||
    typeof inner.deserialize !== 'function'
  ) {
    throw new CacheConfigError('compressedSerializer: inner needs serialize and deserialize');
  }
  const serializer = inner as Serializer;
  const prefix = PREFIXES[algorithm];

  /** The inner string of a prefixed `raw`; throws as `deserialize` does on bad input. */
  const unpack = (raw: string): string => {
    const body = raw.slice(DETECT.length);
    const tag = body.slice(0, 3);
    if (tag !== 'gz:' && tag !== 'br:') {
      throw new Error('Invalid cache payload: unknown compression algorithm');
    }
    const encoded = body.slice(3);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1) {
      throw new Error('Invalid cache payload: not valid base64');
    }
    const bytes = Buffer.from(encoded, 'base64');
    const unpacked =
      tag === 'gz:'
        ? gunzipSync(bytes, { maxOutputLength: maxDecompressedBytes })
        : brotliDecompressSync(bytes, { maxOutputLength: maxDecompressedBytes });
    return unpacked.toString('utf8');
  };

  const compressed: Serializer = {
    serialize(envelope: CacheEnvelope): string {
      const plain = serializer.serialize(envelope);
      const size = Buffer.byteLength(plain, 'utf8');
      if (size <= threshold) return plain;
      // A compressed payload above maxDecompressedBytes could never be read back; plain reads
      // have no such limit.
      if (size > maxDecompressedBytes) return plain;
      const bytes = Buffer.from(plain, 'utf8');
      const packed =
        algorithm === 'gzip'
          ? gzipSync(bytes, { level })
          : brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: level } });
      const out = prefix + packed.toString('base64');
      return out.length < plain.length ? out : plain;
    },
    deserialize(raw: string): CacheEnvelope {
      return serializer.deserialize(raw.startsWith(DETECT) ? unpack(raw) : raw);
    },
  };
  // Only over the built-in JSON serializer, whose format is known. Non-enumerable, so a spread
  // copy with another `deserialize` does not inherit a check that no longer matches it.
  if (serializer === jsonSerializer) {
    Object.defineProperty(compressed, OWN_ENVELOPE, {
      value: (raw: string): boolean | undefined => {
        let plain = raw;
        if (raw.startsWith(DETECT)) {
          try {
            plain = unpack(raw);
          } catch {
            // A value that cannot be decompressed may be anything: never grounds to delete.
            return undefined;
          }
        }
        try {
          const parsed: unknown = JSON.parse(plain);
          return hasOwnVersion(parsed) && !isNewerEnvelope(parsed);
        } catch {
          return false;
        }
      },
    });
  }
  return compressed;
}
