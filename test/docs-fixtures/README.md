# Broken fixture

Each problem below must be reported with its file and line by `scripts/check-docs.mjs`.

A ts block with a type error on its second line:

```ts
import { CacheModule } from '@loipv/nestjs-cache';
const ttl: string = 60_000;
export const module = CacheModule.forRoot({ defaults: { ttl: 1_000 } });
```

A link to a file that does not exist: [missing](docs/missing.md).

A link to a heading that does not exist: [no such section](docs/guide.md#no-such-section).

A `nocheck` block is skipped, even though it does not compile:

```ts nocheck
const broken: number = 'not checked';
```
