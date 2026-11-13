import { keySlot } from './key-slot.js';

function groupBySlot(keys: readonly string[]): Map<number, string[]> {
  const groups = new Map<number, string[]>();
  for (const key of keys) {
    const slot = keySlot(key);
    const group = groups.get(slot);
    if (group === undefined) groups.set(slot, [key]);
    else group.push(key);
  }
  return groups;
}

/** One `mget` per slot, in parallel; resolves the values in input order. Any rejection rejects. */
export async function mgetBySlot(
  keys: readonly string[],
  mget: (slotKeys: string[]) => Promise<(string | undefined)[]>,
): Promise<(string | undefined)[]> {
  if (keys.length === 0) return [];
  const byKey = new Map<string, string | undefined>();
  await Promise.all(
    [...groupBySlot(keys).values()].map(async (slotKeys) => {
      const values = await mget(slotKeys);
      slotKeys.forEach((key, i) => byKey.set(key, values[i]));
    }),
  );
  return keys.map((key) => byKey.get(key));
}

/** One `unlink` per slot via `allSettled`, then rethrows the first rejection. */
export async function unlinkBySlot(
  keys: readonly string[],
  unlink: (slotKeys: string[]) => Promise<void>,
): Promise<void> {
  if (keys.length === 0) return;
  const results = await Promise.allSettled([...groupBySlot(keys).values()].map((g) => unlink(g)));
  for (const result of results) {
    if (result.status === 'rejected') throw result.reason;
  }
}

/**
 * Scans each node to cursor '0' in order and yields the non-empty pages. With `emptyMessage`,
 * zero nodes reject with it on the first iteration: a cluster `clear` that scanned no master
 * would succeed without deleting anything.
 */
export async function* scanNodes<N>(
  nodes: readonly N[],
  scan: (node: N, cursor: string) => Promise<{ cursor: string; keys: string[] }>,
  emptyMessage?: string,
): AsyncIterable<string[]> {
  if (nodes.length === 0 && emptyMessage !== undefined) throw new Error(emptyMessage);
  for (const node of nodes) {
    let cursor = '0';
    do {
      const page = await scan(node, cursor);
      cursor = page.cursor;
      if (page.keys.length > 0) yield page.keys;
    } while (cursor !== '0');
  }
}
