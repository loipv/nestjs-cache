# Stores

This page shows how to set up the memory, Redis (ioredis or node-redis; standalone, Cluster or Sentinel), two-tier and
custom stores.

[Back to the README](../README.md) · See also: [module options](configuration.md#module-options),
[circuit breaker](resilience.md#circuit-breaker), [caveats](caveats.md)

Build stores with the factories (`memoryStore`, `redisStore`, `tieredStore`, `circuitBreakerStore`). The classes
(`MemoryStore`, `RedisStore`, `TieredStore`, `CircuitBreakerStore`) are exported for types and `instanceof` checks only:
do not construct them directly and do not subclass them. To change behaviour, wrap a store in your own `CacheStore`
(see [Custom stores](#custom-stores-and-invalidation-buses)).

## Redis and two-tier setup

You create and close the Redis client yourself. The library only opens one extra connection with
`client.duplicate()` for Pub/Sub and closes it on shutdown.

```ts
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { CacheModule, memoryStore, redisStore, tieredStore } from '@loipv/nestjs-cache';

CacheModule.forRootAsync({
  isGlobal: true,
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => {
    const redis = new Redis(config.getOrThrow<string>('REDIS_URL'));
    return {
      prefix: 'myapp',
      defaults: { ttl: 60_000, jitter: 0.1, cacheNull: false, nullTtl: 30_000 },
      stores: {
        default: tieredStore({
          l1: memoryStore({ maxEntries: 5_000 }),
          l2: redisStore({ client: redis }),
          l1Ttl: 10_000,
        }),
        sessions: redisStore({ client: redis }),
      },
    };
  },
});
```

Every module option is listed in [Configuration](configuration.md#module-options).

`redisStore({ client, channel? })` (`RedisStoreOptions`) accepts an ioredis instance (or a `RedisClientAdapter`). The default
Pub/Sub channel is `nestjs-cache:invalidate`. Redis 6.2 or later is required (the store uses `GETEX`).

`memoryStore({ maxEntries? })` is an LRU store (`MemoryStoreOptions`); `maxEntries` defaults to `1_000`.

`tieredStore({ l1, l2, l1Ttl?, invalidation? })` reads L1 first, then L2 (refilling L1 with `l1Ttl`).
Writes go to L2, then L1 with `min(ttl, l1Ttl)`, then an invalidation message is published.
`l1Ttl` defaults to `10_000`. A received invalidation message longer than 1 MiB (1_048_576 characters) is not parsed:
it clears the whole L1. So does a message with a string `origin` and a body that is not a list of keys or a prefix
(a malformed body, or a format from a newer version), because L1 cannot tell what became stale; a message without a
string `origin` is ignored. A custom invalidation bus gets the same treatment: `{ origin, prefix: 42 }` clears the
whole L1.

## Redis Cluster

Pass an ioredis `Cluster` to `redisStore` as you would a single client:

```ts
import { Cluster } from 'ioredis';
import { CacheModule, memoryStore, redisStore, tieredStore } from '@loipv/nestjs-cache';

const cluster = new Cluster([{ host: 'redis-1', port: 6379 }]);

CacheModule.forRoot({
  prefix: 'myapp',
  stores: {
    default: tieredStore({ l1: memoryStore(), l2: redisStore({ client: cluster }) }),
  },
});
```

- **Versions.** Cluster mode needs ioredis 5.6.0 or later (sharded Pub/Sub) and Redis 7 or later. The adapter creates
  its subscriber with `duplicate([], { shardedSubscribers: true })`, so you do not set `shardedSubscribers` yourself.
  On ioredis below 5.6.0, `SSUBSCRIBE` fails with a `MOVED` redirection error or, on versions whose
  `Cluster` lacks `ssubscribe`, a `TypeError`; either way it is reported as an `error` event with
  `operation: 'subscribe'`. The peer range stays `^5.0.0 || ^6.0.0`.
- **Batches.** `getMany`/`setMany` (`MGET`) and `delete` (`UNLINK`) split their keys per hash slot, so keys in
  different slots work, at one command per slot.
- **`clear`.** It scans every master and deletes the matches. It rejects (a store error and an `error` event) when the
  cluster client does not know a master yet, for example a `lazyConnect` client before its first command. It can miss
  keys that move between nodes during resharding. Versioned namespaces are not affected: their `clear` only writes a
  new token.
- **No automatic hash tags.** Keys are not wrapped in `{...}`, so related keys can live on different nodes.
- Calling `scan` directly on a cluster-mode adapter rejects with `CacheConfigError` pointing to `scanIterator`.
- **Sync.** The invalidation bus uses sharded Pub/Sub (`SPUBLISH`/`SSUBSCRIBE`).

## node-redis

`nodeRedisAdapter` wraps a [`redis`](https://github.com/redis/node-redis) client, cluster or Sentinel (v5 or v6).
`redis` (`^5.0.0 || ^6.0.0`) is an optional peer dependency. Pass a client that is already `connect()`ed: the
adapter only connects the subscriber connection it duplicates itself. Cluster mode is detected automatically (the
client has `masters`).

```ts
import { createClient, createCluster } from 'redis';
import { nodeRedisAdapter, redisStore } from '@loipv/nestjs-cache';

// standalone
const client = createClient({ url: process.env.REDIS_URL });
await client.connect();
const standalone = redisStore({ client: nodeRedisAdapter(client) });

// cluster
const cluster = createCluster({ rootNodes: [{ url: 'redis://redis-1:6379' }] });
await cluster.connect();
const clustered = redisStore({ client: nodeRedisAdapter(cluster) });
```

The same cluster rules apply (Redis 7+, per-slot batches, `clear` scans every master). The types are
`NodeRedisLike` and `NodeRedisClusterLike`.

- A standalone node-redis client signals reconnects, so L1 is cleared after one, as with ioredis.
- A node-redis cluster gives no reliable post-reconnect signal, so after a reconnect the tiered store is not told to
  clear L1: L1 can serve stale entries for up to `l1Ttl`. Node errors (`'node-error'`, `'error'`) are reported as
  `error` events with `operation: 'subscribe'`.
- If the client's reconnect strategy gives up (ioredis `retryStrategy` returning `null`, node-redis
  `reconnectStrategy` returning `false` or an `Error`), the invalidation subscription is not retried and L1 sync stays
  off for that instance until restart; the failure is reported (possibly twice: once from the client's error event and
  once from the failed subscribe). With the default strategies the subscriber keeps retrying.

## Redis Sentinel

Redis Sentinel works with both clients. Every command goes to the current master; the sentinels are used for
discovery and failover only (replica reads are planned for 0.9).

**ioredis.** Pass a client built with `sentinels` and `name` to `redisStore`, as you would a single client:

```ts
import { Redis } from 'ioredis';
import { CacheModule, memoryStore, redisStore, tieredStore } from '@loipv/nestjs-cache';

const redis = new Redis({
  sentinels: [
    { host: 'sentinel-1', port: 26379 },
    { host: 'sentinel-2', port: 26379 },
    { host: 'sentinel-3', port: 26379 },
  ],
  name: 'mymaster',
});

CacheModule.forRoot({
  stores: { default: tieredStore({ l1: memoryStore(), l2: redisStore({ client: redis }) }) },
});
```

The Pub/Sub connection comes from `duplicate()` and re-subscribes after a failover. After a failover an ioredis
subscriber can miss invalidation messages for about 10 s (the old master drops it late); like any lost message this is
bounded by `l1Ttl`.

**node-redis (v5 or v6).** Pass a `createSentinel(...)` object that is already `connect()`ed to `nodeRedisAdapter`. It is
detected automatically (the type is `NodeRedisSentinelLike`):

```ts
import { createSentinel } from 'redis';
import { nodeRedisAdapter, redisStore } from '@loipv/nestjs-cache';

const sentinel = createSentinel({
  name: 'mymaster',
  sentinelRootNodes: [{ host: 'sentinel-1', port: 26379 }],
});
sentinel.on('error', (err) => console.error(err));
await sentinel.connect();
const store = redisStore({ client: nodeRedisAdapter(sentinel) });
```

- The invalidation subscriber subscribes on the sentinel object itself (it does not duplicate it). Closing the store
  only unsubscribes its channels and never closes your client.
- A Sentinel `MASTER_CHANGE` clears L1, because messages published during a failover are lost. node-redis emits it
  before its pub/sub connection has moved to the new master, so an L1 backfill in that gap can still miss an
  invalidation; like any lost message this is bounded by `l1Ttl`.
- While a tiered store is open over it, the sentinel's `'error'` events are also reported as `error` events with
  `operation: 'subscribe'`. Still attach your own `'error'` listener.
- **`nodeAddressMap` and a tiered store (`redis` 5).** With `redis` 5 (seen with 5.12.1), node-redis applies
  `nodeAddressMap` to its data connections but not to its Sentinel pub/sub connection, which connects to the address
  the sentinel announces. If that address cannot be reached from your app (NAT, Docker port mapping, Kubernetes
  without routable pod IPs), the tiered store's invalidation subscription never connects. After a failover node-redis
  then waits for that connection before it uses the new master, so every command on that client hangs, and `close()`
  hangs too. Any SUBSCRIBE on the client triggers it, not only this library's. It is verified fixed with `redis`
  6.3.1; use 6.3.1 or later. With an earlier version, if the master and replica addresses the sentinels announce are
  reachable from your app, you are not affected. Otherwise use `redis` 6.3.1 or later, use ioredis (`natMap` covers
  its subscriber too), make the announced addresses reachable (`replica-announce-ip` / `sentinel announce-ip`), or do
  not put a tiered store over it.

## Custom stores and invalidation buses

Implement the `CacheStore` interface (see the TSDoc in `src/stores/cache-store.interface.ts`):

```ts
import type { CacheEventSink, InvalidationBus, LockProvider } from '@loipv/nestjs-cache';

interface CacheStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  delete(keys: readonly string[]): Promise<void>;
  clear(prefix: string): Promise<void>;
  getAndTouch?(key: string, ttlMs: number): Promise<string | undefined>; // used by 'sliding'
  getMany?(keys: readonly string[]): Promise<(string | undefined)[]>; // used by getMany / getOrSetMany
  setMany?(entries: readonly { key: string; value: string; ttlMs: number }[]): Promise<void>; // used by setMany
  readonly lock?: LockProvider; // used by the distributed lock
  readonly invalidation?: InvalidationBus;
  bind?(events: CacheEventSink): void;
  close?(): Promise<void>;
}
```

`getStrict` and `setStrict` are only needed by stores whose `get`/`set` degrade instead of rejecting, as a
`tieredStore` does. They reject when the durable tier cannot be read or written, and the engine uses them for version
tokens. Stores whose `get`/`set` already reject (memory, Redis) can leave them out.

`getAndTouch` should be implemented by stores that can do it atomically: without it, `sliding` falls back to a `get`
followed by a `set`, which is not atomic. `lock` is a `LockProvider` (`acquire(key, ttlMs)` returns a `LockHandle` or
`undefined`; `LockHandle.release()` frees it). `getMany` and `setMany` are optional: without them the engine calls `get` and `set` for each key. Leave these members out when unsupported; do not define them as
`undefined`.

The interfaces you implement (`CacheStore`, `LockProvider`, `InvalidationBus`, `RedisClientAdapter` and the other
ones) only gain optional members in 1.x, and the library checks that an optional member exists before it calls it, so
an implementation written for 1.0 keeps working. See [Stability and semver](semver.md#interfaces-you-implement).

A custom store can be the L2 of a `tieredStore`. L1 synchronisation is separate from storage: `tieredStore`
uses `options.invalidation` if given, otherwise `l2.invalidation`.

| Configuration                                                                                                                                   | L1 sync between instances                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| L2 is a `redisStore`                                                                                                                            | Automatic, over Redis Pub/Sub on that client                                                    |
| Custom L2 with an `invalidation` property                                                                                                       | Automatic, through that store's bus                                                             |
| Custom L2 plus an explicit `invalidation` option (for example `redisInvalidationBus({ client, channel? })`, or your own bus over NATS or Kafka) | Through the bus you pass                                                                        |
| No bus at all                                                                                                                                   | No sync. After a write or delete on another instance, L1 may serve stale data for up to `l1Ttl` |

The bus only affects L1 freshness. Data in L2 is always correct, and a single-instance app is not affected by a missing bus.
Without a bus, `tieredStore` still works and logs a warning at startup. When the Pub/Sub connection is
re-established, L1 is cleared because messages may have been missed. If Redis is unreachable when the app starts,
the subscription is retried once the connection is ready. This automatic re-subscribe after a failure happens with
ioredis clients (through `ioredisAdapter`) and node-redis clients (through `nodeRedisAdapter`); custom adapters and buses
must retry themselves. A bus may implement the optional `onError(handler)`;
`tieredStore` reports those errors as `error` events with `operation: 'subscribe'` (the Redis bus reports
errors of its subscriber connection this way).

### Custom Redis adapters

How the library tells clients apart:

- `redisStore({ client })` and `redisInvalidationBus({ client })` treat the value as a `RedisClientAdapter` when its
  `createSubscriber` is a function; any other value is wrapped with `ioredisAdapter` as an ioredis client.
- `ioredisAdapter` runs in Cluster mode when `client.isCluster === true`, and uses `client.nodes('master')` for `clear`.
- `nodeRedisAdapter` runs in Cluster mode when the client has `masters`, in Sentinel mode when `getSentinelNode` is a
  function, and as a single node otherwise. A Sentinel has no `duplicate`: its subscriber uses the Sentinel itself.

`redisStore({ client })` also accepts a `RedisClientAdapter` (see the TSDoc in `src/stores/redis-client.adapter.ts`).
Two rules matter for Cluster:

- `mget` and `unlink` receive keys that may belong to several hash slots. A Cluster adapter must split the command per
  slot.
- `scanIterator?(match, count)` is optional. When present, `clear` uses it instead of the `scan` cursor loop; it must
  yield the matching keys of every node that holds data (each master of a cluster), in pages.
