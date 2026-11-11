# Clean fixture

`scripts/check-docs.mjs --root test/docs-fixtures/clean` must pass on this directory.

```ts
import { Injectable } from '@nestjs/common';
import { Cacheable, CacheModule } from '@loipv/nestjs-cache';

declare class User {
  id: string;
}

@Injectable()
export class UserService {
  @Cacheable({ namespace: 'users', key: 'user:{0}' })
  findById(id: string): Promise<User | null> {
    /* ... */
  }
}

export const module = CacheModule.forRoot({ isGlobal: true });
await Promise.resolve();
```

```ts nocheck
const fragment: number = 'skipped';
```

```bash
echo "not a ts block"
```

Links: [the guide](docs/guide.md), [its first section](docs/guide.md#first-section-with-code),
[the repeated heading](docs/guide.md#repeated-1), [this page](#clean-fixture), [a directory](docs) and
[an external page](https://example.com/#anything). Link syntax in inline code is ignored: `[x](nowhere.md)`.
