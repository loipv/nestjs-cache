import { describe, expect, it, vi } from 'vitest';
import { mgetBySlot, scanNodes, unlinkBySlot } from '../../../src/stores/cluster-ops.js';

describe('mgetBySlot', () => {
  /* Duplicate and same-slot keys: one MGET per slot, result aligned to the input order. */
  it('mgetBySlot keeps input order with duplicate and same-slot keys', async () => {
    const mget = vi.fn((keys: string[]) => Promise.resolve(keys.map((k) => `v:${k}`)));
    const result = await mgetBySlot(['a', 'a', '{t}x', '{t}y'], mget);
    expect(result).toEqual(['v:a', 'v:a', 'v:{t}x', 'v:{t}y']);
    const tagged = mget.mock.calls.filter(([keys]) => keys.includes('{t}x'));
    expect(tagged).toHaveLength(1);
    expect(tagged[0]?.[0].sort()).toEqual(['{t}x', '{t}y']);
    expect(mget).toHaveBeenCalledTimes(2);
  });

  /* Missing values stay undefined at their own position. */
  it('mgetBySlot keeps undefined for missing keys', async () => {
    const mget = vi.fn((keys: string[]) =>
      Promise.resolve(keys.map((k) => (k === 'b' ? undefined : k))),
    );
    expect(await mgetBySlot(['a', 'b'], mget)).toEqual(['a', undefined]);
  });

  /* A failing slot rejects the whole call. */
  it('mgetBySlot rejects when one slot rejects', async () => {
    const mget = vi.fn((keys: string[]) =>
      keys.includes('b') ? Promise.reject(new Error('boom')) : Promise.resolve(keys),
    );
    await expect(mgetBySlot(['a', 'b'], mget)).rejects.toThrow('boom');
  });

  /* An empty list sends nothing. */
  it('mgetBySlot([]) resolves [] without calling mget', async () => {
    const mget = vi.fn(() => Promise.resolve([]));
    expect(await mgetBySlot([], mget)).toEqual([]);
    expect(mget).not.toHaveBeenCalled();
  });
});

describe('unlinkBySlot', () => {
  /* An empty list sends nothing. */
  it('unlinkBySlot([]) makes no call', async () => {
    const unlink = vi.fn(() => Promise.resolve());
    await unlinkBySlot([], unlink);
    expect(unlink).not.toHaveBeenCalled();
  });

  /* Every slot is attempted even when one fails; the first rejection is rethrown. */
  it('unlinkBySlot runs every slot and rethrows the first error', async () => {
    // slots: a=15495, b=3300... keys chosen from distinct slots
    const keys = ['a', 'b', 'c'];
    const unlink = vi.fn((slotKeys: string[]) =>
      slotKeys[0] === 'b' ? Promise.reject(new Error('second')) : Promise.resolve(),
    );
    await expect(unlinkBySlot(keys, unlink)).rejects.toThrow('second');
    expect(unlink).toHaveBeenCalledTimes(3);
  });
});

describe('scanNodes', () => {
  /* Each node is walked to cursor 0 in order; empty pages are not yielded. */
  it('scanNodes walks every node to cursor 0 and skips empty pages', async () => {
    const pages: Record<string, { cursor: string; keys: string[] }[]> = {
      n1: [
        { cursor: '5', keys: ['a'] },
        { cursor: '0', keys: ['b'] },
      ],
      n2: [
        { cursor: '7', keys: [] },
        { cursor: '0', keys: ['c'] },
      ],
    };
    const calls: string[] = [];
    const scan = (node: string, cursor: string) => {
      calls.push(`${node}:${cursor}`);
      const page = pages[node]?.shift();
      return Promise.resolve(page ?? { cursor: '0', keys: [] });
    };
    const out: string[][] = [];
    for await (const page of scanNodes(['n1', 'n2'], scan)) out.push(page);
    expect(out).toEqual([['a'], ['b'], ['c']]);
    expect(calls).toEqual(['n1:0', 'n1:5', 'n2:0', 'n2:7']);
  });

  /* 0.5-T6-1: with an emptyMessage, zero nodes reject on the first iteration (a clear must not
     succeed while scanning nothing); without one, zero nodes yield nothing. */
  it('scanNodes rejects zero nodes with emptyMessage and yields nothing without it', async () => {
    const scan = vi.fn(() => Promise.resolve({ cursor: '0', keys: ['x'] }));
    const pages: string[][] = [];
    const iterating = (async () => {
      for await (const page of scanNodes([], scan, 'no node known')) pages.push(page);
    })();
    await expect(iterating).rejects.toThrow('no node known');
    for await (const page of scanNodes([], scan)) pages.push(page);
    expect(pages).toEqual([]);
    expect(scan).not.toHaveBeenCalled();
  });
});
