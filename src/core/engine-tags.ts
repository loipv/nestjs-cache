import type { Target } from './engine-keys.js';
import type { ReportError } from './events.js';
import type { VersionTokens } from './version-tokens.js';

/** The most tags one entry carries, counted after de-duplication (spec 2.5). */
export const MAX_TAGS = 32;

/** The tag versions an entry was written with: each tag mapped to its token. */
export type TagStamp = Readonly<Record<string, string>>;

/**
 * The engine-level tags of a single write (D2). An array is known before the load, so its tokens
 * are taken before the loader runs; a function gets the value once the write is decided.
 */
export type TagOption<T> = readonly string[] | ((value: T) => readonly string[]);

/** The tags of a batch write (D2): an array for every entry, or a function of each entry. */
export type BatchTagOption<T> = readonly string[] | ((value: T, key: string) => readonly string[]);

/**
 * How a write is stamped: a stamp (empty means the untagged 0.6 envelope), or `'skip'` after a
 * reported failure, and the entry is then not written.
 */
export type Stamping = TagStamp | 'skip';

/**
 * How a read entry's stamp compares with the current tag tokens: `valid` (served), `invalid`
 * (a miss, loaded and written as usual) or `uncertain` (the tokens could not be read: a miss
 * that is loaded without writing, spec 3.2 step 4).
 */
export type TagCheck = 'valid' | 'invalid' | 'uncertain';

/**
 * `raw` as a tag list: an array of non-empty strings, de-duplicated (first occurrence kept), at
 * most `MAX_TAGS` long. Always a new array. Throws a `TypeError` naming the broken rule.
 */
export function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new TypeError(`Invalid tags: ${String(raw)}. Tags must be an array of strings.`);
  }
  const unique = new Set<string>();
  for (const tag of raw as readonly unknown[]) {
    if (typeof tag !== 'string') {
      throw new TypeError(`Invalid tag: ${String(tag)}. Every tag must be a string.`);
    }
    if (tag === '') throw new TypeError('Invalid tag: a tag must not be an empty string.');
    unique.add(tag);
  }
  if (unique.size > MAX_TAGS) {
    throw new TypeError(
      `Too many tags: ${String(unique.size)}. An entry carries at most ${String(MAX_TAGS)} tags.`,
    );
  }
  return [...unique];
}

/**
 * The stamp of `names` from `tokens`; built with own keys, so `__proto__` is a plain tag. A name
 * without a token makes it `'skip'`: a partial stamp would survive that tag's invalidation.
 */
function stampOf(names: readonly string[], tokens: ReadonlyMap<string, string>): Stamping {
  const entries: [string, string][] = [];
  for (const name of names) {
    const token = tokens.get(name);
    if (token === undefined) return 'skip';
    entries.push([name, token]);
  }
  return Object.fromEntries(entries);
}

/**
 * The check of one stamp against `current`. A missing current token (the tag key is gone) is
 * `invalid`; with `fallback` (the last known tokens after a failed read) it is `uncertain`,
 * unless another tag of the stamp is known to differ.
 */
function checkStamp(
  stamp: TagStamp,
  current: ReadonlyMap<string, string | undefined>,
  fallback: boolean,
): TagCheck {
  let unknown = false;
  for (const [tag, token] of Object.entries(stamp)) {
    const now = current.get(tag);
    if (now === undefined && fallback) unknown = true;
    else if (now !== token) return 'invalid';
  }
  return unknown ? 'uncertain' : 'valid';
}

/**
 * The tags worth re-reading (spec 3.3 step 1): those of each stamp that differs from `current`
 * only in tokens this call took from the process cache. A stamp that differs in a token just
 * read from the store (or a missing one) is a miss whatever the cached tokens say.
 */
function suspectTags(
  stamps: readonly TagStamp[],
  current: ReadonlyMap<string, string | undefined>,
  fromCache: ReadonlySet<string>,
): Set<string> {
  const suspects = new Set<string>();
  for (const stamp of stamps) {
    const differing = Object.entries(stamp).flatMap(([tag, token]) =>
      current.get(tag) === token ? [] : [tag],
    );
    if (differing.every((tag) => fromCache.has(tag))) {
      for (const tag of differing) suspects.add(tag);
    }
  }
  return suspects;
}

/** Whether `stamp` adds a `tags` field: an absent or empty stamp does not. */
export function hasTags(stamp: TagStamp | undefined): stamp is TagStamp {
  return stamp !== undefined && Object.keys(stamp).length > 0;
}

/**
 * Whether the tags are known before the load: anything set that is not a function (an array, or
 * an invalid value that `normalizeTags` then reports). Their tokens are taken before the loader.
 */
export function knownTags<O>(option: O | undefined): option is Exclude<O, CallableFunction> {
  return option !== undefined && typeof option !== 'function';
}

/** `items` with their stamps (same order); a skipped item is left out. */
function applyStamps<I>(
  items: readonly I[],
  stamps: readonly Stamping[],
): (I & { tags: TagStamp })[] {
  return items.flatMap((item, i) => {
    const stamp = stamps[i];
    return stamp === undefined || stamp === 'skip' ? [] : [{ ...item, tags: stamp }];
  });
}

/**
 * Tag stamps for writes (spec 3.3). An invalid tag list (a throwing callback included) is one
 * `tag` error per call; a failure to take the tokens is one `version` error. Either way the
 * affected entries are skipped, never the caller's call.
 */
export class EngineTags {
  constructor(
    private readonly tokens: VersionTokens,
    private readonly reportError: ReportError,
  ) {}

  /** The stamp of one write; `produce` returns the raw tags (a list, or a callback's result). */
  async stamp(target: Target, produce: () => unknown): Promise<Stamping> {
    const [stamping] = await this.stampEach(target, [produce]);
    return stamping ?? 'skip';
  }

  /**
   * The stamp of `option` for `value`: an array as is, a function called with the value. Used
   * where the value is known (set, put, the write after a load with a tag function).
   */
  stampFor<T>(target: Target, option: TagOption<T>, value: T): Promise<Stamping> {
    return this.stamp(target, () => (typeof option === 'function' ? option(value) : option));
  }

  /**
   * The stamps of several writes, in input order, with one `ensureMany` for all their tags.
   * One `tag` error covers every invalid list; one `version` error every failed token.
   */
  async stampEach(target: Target, produce: readonly (() => unknown)[]): Promise<Stamping[]> {
    const lists: (string[] | undefined)[] = [];
    let invalid: { error: unknown } | undefined;
    for (const tags of produce) {
      try {
        lists.push(normalizeTags(tags()));
      } catch (error) {
        invalid ??= { error };
        lists.push(undefined);
      }
    }
    if (invalid !== undefined) this.reportError(target.name, 'tag', invalid.error);
    const names = [...new Set(lists.flatMap((list) => list ?? []))];
    let tokens: ReadonlyMap<string, string> = new Map();
    if (names.length > 0) {
      try {
        tokens = await this.tokens.ensureMany(target, 'tag', names);
      } catch (error) {
        this.reportError(target.name, 'version', error);
        return lists.map((list) => (list?.length === 0 ? {} : 'skip'));
      }
    }
    return lists.map((list) => (list === undefined ? 'skip' : stampOf(list, tokens)));
  }

  /**
   * The checks of read entries' stamps, in input order, with one `currentMany` for the union of
   * their tags (spec 3.2). A failed token read is one `version` error for the call; a store with
   * `getStrict` then compares with the tokens this process last knew (even past `cacheTtl`), and
   * any other store makes every stamp `uncertain`. A stamp that differs only in tokens served
   * from the process cache gets those tags re-read (`recheck`), then is checked again (3.3).
   */
  async verify(target: Target, stamps: readonly TagStamp[]): Promise<TagCheck[]> {
    const names = [...new Set(stamps.flatMap((stamp) => Object.keys(stamp)))];
    const fromCache = new Set<string>();
    let current: ReadonlyMap<string, string | undefined>;
    let fallback = false;
    try {
      current = await this.tokens.currentMany(target, 'tag', names, fromCache);
    } catch (error) {
      this.reportError(target.name, 'version', error);
      if (target.store.getStrict === undefined) return stamps.map(() => 'uncertain');
      current = new Map(names.map((name) => [name, this.tokens.cached(target, 'tag', name)]));
      fallback = true;
    }
    if (!fallback) {
      const suspects = suspectTags(stamps, current, fromCache);
      if (suspects.size > 0) current = await this.recheck(target, current, suspects);
    }
    return stamps.map((stamp) => checkStamp(stamp, current, fallback));
  }

  /**
   * `current` with `suspects` re-read, each at most once and in parallel; a tag refused by the
   * rate limit, or whose re-read fails, keeps its cached token (so its stamps stay a miss).
   * Failed re-reads are one `version` error. Without any re-read, `current` as it is, at once.
   */
  private async recheck(
    target: Target,
    current: ReadonlyMap<string, string | undefined>,
    suspects: ReadonlySet<string>,
  ): Promise<ReadonlyMap<string, string | undefined>> {
    const reads: (readonly [string, Promise<string | undefined>])[] = [];
    for (const name of suspects) {
      const read = this.tokens.recheck(target, 'tag', name);
      if (read !== undefined) reads.push([name, read]);
    }
    if (reads.length === 0) return current;
    const updated = new Map(current);
    const failures: unknown[] = [];
    await Promise.all(
      reads.map(([name, read]) =>
        read.then(
          (token) => {
            updated.set(name, token);
          },
          (error: unknown) => {
            failures.push(error);
          },
        ),
      ),
    );
    if (failures.length > 0) this.reportError(target.name, 'version', failures[0]);
    return updated;
  }

  /**
   * Gives each of `names` (valid, de-duplicated) a new token (spec 3.4); this instance uses the
   * new tokens at once. Every tag is tried; a failure is one `version` error, then the call
   * rejects with the first failing tag's error.
   */
  async invalidate(target: Target, names: readonly string[]): Promise<void> {
    try {
      await this.tokens.bumpMany(target, 'tag', names);
    } catch (error) {
      this.reportError(target.name, 'version', error);
      throw error;
    }
  }

  /**
   * The batch writes `items` stamped for `option` together (one token call), in input order; an
   * item whose tags fail is left out. Without tags or items, `items` as they are.
   */
  async stampWrites<T, I extends { readonly value: T; readonly ref: { readonly key: string } }>(
    target: Target,
    option: BatchTagOption<T> | undefined,
    items: readonly I[],
  ): Promise<readonly I[]> {
    if (option === undefined || items.length === 0) return items;
    const entries = items.map(({ value, ref }) => ({ value, key: ref.key }));
    return applyStamps(items, await this.stampBatch(target, option, entries));
  }

  /**
   * The stamps of batch entries for `option`: an array is stamped once for all of them, a
   * function is called with each entry's value and key.
   */
  async stampBatch<T>(
    target: Target,
    option: BatchTagOption<T>,
    entries: readonly { readonly value: T; readonly key: string }[],
  ): Promise<Stamping[]> {
    if (typeof option !== 'function') {
      const stamping = await this.stamp(target, () => option);
      return entries.map(() => stamping);
    }
    const produce = entries.map(
      ({ value, key }) =>
        () =>
          option(value, key),
    );
    return this.stampEach(target, produce);
  }
}
