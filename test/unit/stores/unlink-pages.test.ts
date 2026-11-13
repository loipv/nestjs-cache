import { describe, expect, it, vi } from 'vitest';
import { unlinkPages } from '../../../src/stores/unlink-pages.js';

interface Deferred {
  resolve: () => void;
  reject: (error: Error) => void;
  promise: Promise<void>;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { resolve, reject, promise };
}

/** Runs every pending microtask: all the work under test is promise-based, with no timers. */
const flush = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

function harness(pageCount: number, failAtPage?: number) {
  const pulled: number[] = [];
  const unlinks: Deferred[] = [];
  async function* pages(): AsyncGenerator<string[]> {
    for (let i = 1; i <= pageCount; i += 1) {
      pulled.push(i);
      if (i === failAtPage) throw new Error('scan failed');
      yield [`k${String(i)}`];
    }
  }
  const unlink = (): Promise<void> => {
    const d = deferred();
    unlinks.push(d);
    return d.promise;
  };
  return { pages: pages(), pulled, unlinks, unlink };
}

describe('unlinkPages', () => {
  it('keeps at most `concurrency` unlinks in flight', async () => {
    const h = harness(10);
    void unlinkPages(h.pages, h.unlink, 4).catch(() => undefined);
    await flush();
    expect(h.unlinks).toHaveLength(4);
    // The fifth page is pulled and waits for a free slot.
    expect(h.pulled).toEqual([1, 2, 3, 4, 5]);
  });

  it('overlaps the scan with the unlinks', async () => {
    const h = harness(3);
    const done = unlinkPages(h.pages, h.unlink, 4);
    await flush();
    expect(h.pulled).toEqual([1, 2, 3]);
    expect(h.unlinks).toHaveLength(3);
    for (const d of h.unlinks) d.resolve();
    await done;
  });

  it('stops pulling and rejects with the unlink error after the others settle', async () => {
    const h = harness(10);
    let outcome: unknown = 'pending';
    const done = unlinkPages(h.pages, h.unlink, 3).catch((e: unknown) => {
      outcome = e;
    });
    await flush();
    expect(h.unlinks).toHaveLength(3);
    // The fourth page is pulled and waits for a free slot.
    expect(h.pulled).toEqual([1, 2, 3, 4]);
    const boom = new Error('unlink 2 failed');
    h.unlinks[1]!.reject(boom);
    await flush();
    expect(outcome).toBe('pending');
    h.unlinks[0]!.resolve();
    await flush();
    expect(outcome).toBe('pending');
    h.unlinks[2]!.resolve();
    await done;
    expect(outcome).toBe(boom);
    // The waiting page is dropped once the slot frees: nothing more is pulled or unlinked.
    expect(h.pulled).toEqual([1, 2, 3, 4]);
    expect(h.unlinks).toHaveLength(3);
  });

  it('closes the iterator on an unlink failure', async () => {
    const h = harness(10);
    const close = vi.spyOn(h.pages, 'return');
    const boom = new Error('unlink failed');
    const done = unlinkPages(h.pages, h.unlink, 2);
    await flush();
    expect(h.unlinks).toHaveLength(2);
    h.unlinks[0]!.reject(boom);
    h.unlinks[1]!.resolve();
    await expect(done).rejects.toBe(boom);
    expect(close).toHaveBeenCalledOnce();
    expect(h.pulled).toEqual([1, 2, 3]);
  });

  it('rejects with the unlink error when the scan and an in-flight unlink both fail', async () => {
    /* The scan fails at page 3 while the unlinks of pages 1 and 2 are in flight; one of them
       then fails too. The unlink error wins. */
    const h = harness(10, 3);
    const done = unlinkPages(h.pages, h.unlink, 4);
    await flush();
    expect(h.pulled).toEqual([1, 2, 3]);
    expect(h.unlinks).toHaveLength(2);
    const boom = new Error('unlink 1 failed');
    h.unlinks[0]!.reject(boom);
    h.unlinks[1]!.resolve();
    await expect(done).rejects.toBe(boom);
  });

  it('rejects with the iterator error after the in-flight unlinks settle', async () => {
    const h = harness(10, 3);
    let outcome: unknown = 'pending';
    const done = unlinkPages(h.pages, h.unlink, 4).catch((e: unknown) => {
      outcome = e;
    });
    await flush();
    expect(h.unlinks).toHaveLength(2);
    expect(outcome).toBe('pending');
    for (const d of h.unlinks) d.resolve();
    await done;
    expect((outcome as Error).message).toBe('scan failed');
  });

  it('sends nothing for empty pages', async () => {
    async function* empty(): AsyncGenerator<string[]> {
      yield [];
      yield [];
    }
    let calls = 0;
    await unlinkPages(
      empty(),
      () => {
        calls += 1;
        return Promise.resolve();
      },
      4,
    );
    expect(calls).toBe(0);
  });
});
