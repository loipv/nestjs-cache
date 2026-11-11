import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from 'node:zlib';
import { CacheConfigError } from '../errors.js';
import type { CacheEnvelope } from '../core/envelope.js';
import { jsonSerializer, type Serializer } from './json.serializer.js';

export interface CompressedSerializerOptions {
  /** Produces and reads the string that gets compressed. Default `jsonSerializer`. */
  inner?: Serializer;
  /** Algorithm used for writes; reads follow the prefix of the stored value. Default `'gzip'`. */
  algorithm?: 'gzip' | 'brotli';
  /** UTF-8 byte length of the inner string above which compression is tried. Default 1024. */
  threshold?: number;
  /**
   * Upper bound of a decompressed payload, in bytes. Default 16 MiB. Larger payloads are written
   * uncompressed so they stay readable.
   */
  maxDecompressedBytes?: number;
}

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

  return {
    serialize(envelope: CacheEnvelope): string {
      const plain = serializer.serialize(envelope);
      const size = Buffer.byteLength(plain, 'utf8');
      if (size <= threshold) return plain;
      // A compressed payload above maxDecompressedBytes could never be read back; plain reads
      // have no such limit.
      if (size > maxDecompressedBytes) return plain;
      const bytes = Buffer.from(plain, 'utf8');
      const packed = algorithm === 'gzip' ? gzipSync(bytes) : brotliCompressSync(bytes);
      const out = prefix + packed.toString('base64');
      return out.length < plain.length ? out : plain;
    },
    deserialize(raw: string): CacheEnvelope {
      if (!raw.startsWith(DETECT)) return serializer.deserialize(raw);
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
      return serializer.deserialize(unpacked.toString('utf8'));
    },
  };
}
