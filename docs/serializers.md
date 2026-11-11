# Serializers

This page explains how cache entries become stored strings, how to plug in your own `Serializer`, and how to compress
large payloads.

[Back to the README](../README.md) · See also: [module options](configuration.md#module-options),
[caveats](caveats.md)

## Serializer

The engine stores each entry as a `CacheEnvelope` (the value plus its expiry timestamps, the empty-value marker and
the tag stamp), and the module `serializer` turns it into the string the store holds. The default, `jsonSerializer`,
uses `JSON.stringify` and `JSON.parse` and checks the envelope shape, so values go through JSON (see
[Caveats](caveats.md)).

To keep other types, pass your own `Serializer` as the module `serializer`:

```ts
import type { CacheEnvelope } from '@loipv/nestjs-cache';

interface Serializer {
  serialize(envelope: CacheEnvelope): string;
  deserialize(raw: string): CacheEnvelope;
}
```

- `deserialize` must throw on input it does not recognise. The engine reports that as an `error` event with
  `operation: 'deserialize'` and treats the entry as a miss.
- Every envelope field must survive the round trip, `tags` included, or tag invalidation is silently disabled.
- When you switch serializers, entries the new one cannot read are `deserialize` errors and misses until they expire.

## Compression

`compressedSerializer` wraps a serializer and compresses large payloads with gzip or brotli. Pass it as the module
`serializer`:

```ts
import { CacheModule, compressedSerializer } from '@loipv/nestjs-cache';

CacheModule.forRoot({
  serializer: compressedSerializer({ algorithm: 'gzip', threshold: 1024 }),
});
```

| Option                 | Default          | Meaning                                                                 |
| ---------------------- | ---------------- | ----------------------------------------------------------------------- |
| `inner`                | `jsonSerializer` | Serializer that produces and reads the string that gets compressed      |
| `algorithm`            | `'gzip'`         | `'gzip'` or `'brotli'`, used for writes                                 |
| `threshold`            | `1024`           | Payloads whose UTF-8 byte length is above it are tried for compression  |
| `maxDecompressedBytes` | 16 MiB           | Upper bound of a decompressed payload; larger ones are rejected on read |

- It compresses only above `threshold` and only when the result is shorter. Smaller payloads are stored as `inner`
  writes them, and uncompressed payloads are always readable, so a rolling deploy from an uncompressed serializer is
  safe.
- Payloads above `maxDecompressedBytes` are stored uncompressed, so every value it writes can be read back.
- The algorithm is taken from the prefix of the stored value, not from the configuration, so switching between `gzip`
  and `brotli` is safe: old entries stay readable.
- Switching back from `compressedSerializer` to an uncompressed serializer makes the compressed entries unreadable:
  they produce `deserialize` errors and are misses until they expire.
- Compression is synchronous (`node:zlib`) and costs event-loop CPU on large payloads; `brotli` compresses smaller
  and slower than `gzip`.
- A corrupt or oversized payload is a `deserialize` error and a miss, like any unreadable entry.
- Invalid options throw `CacheConfigError` when the serializer is created.
- `inner` must not produce strings that start with `"\u0000nc1:"`, the prefix the compressed values use.
