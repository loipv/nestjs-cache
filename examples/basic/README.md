# Example: basic

A NestJS 12 app that uses `@loipv/nestjs-cache`: `@Cacheable` with tags on a service, `@CacheEvict({ tags })`,
`@HttpCache` on a route, and optional Redis and Prometheus. The code starts in [`src/app.module.ts`](src/app.module.ts).

## Run it

The app imports the library as a package, but its `package.json` does not list it: the library is installed from a
tarball packed from this repository.

The quickest way, from the repository root:

```sh
npm run example:check
```

It builds and packs the library, installs the tarball here, type-checks the app and runs its smoke test, which prints
`SMOKE OK`. The smoke test uses the in-memory store and needs no Redis.

To start the app yourself:

```sh
# in the repository root
npm ci --ignore-scripts
npm run build
PACK_DIR=$(mktemp -d)  # a fresh directory, so no older tarball can match below
npm pack --ignore-scripts --pack-destination "$PACK_DIR"

cd examples/basic
npm install --ignore-scripts --no-package-lock
npm install --ignore-scripts --no-save --no-package-lock "$PACK_DIR"/loipv-nestjs-cache-*.tgz
npm run build
npm start
```

| Variable    | Effect                                                                                       |
| ----------- | -------------------------------------------------------------------------------------------- |
| `REDIS_URL` | For example `redis://localhost:6379`: the default store is Redis (ioredis). Unset: in-memory |
| `METRICS`   | Any non-empty value: Prometheus metrics are recorded and served on `GET /metrics`            |
| `PORT`      | The port `npm start` listens on (default `3000`)                                             |

## Routes

- `GET /catalog`: the product list, cached with `@HttpCache` under the tag `catalog`.
- `GET /products/:id`: one product, from `ProductsService.find` (`@Cacheable`, tag `product:<id>`).
- `PATCH /products/:id` with `{ "name": "..." }`: renames it; `@CacheEvict` evicts `product:<id>` and `catalog`.
- `GET /stats`: how many times the product loader and the catalog handler really ran, to tell hits from misses.
