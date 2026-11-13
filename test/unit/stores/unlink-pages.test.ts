import { describe, expect, it } from 'vitest';
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

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

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
    await tick();
    expect(h.unlinks).toHaveLength(4);
    expect(h.pulled.length).toBeLessThanOrEqual(5);
  });

  it('overlaps the scan with the unlinks', async () => {
    const h = harness(3);
    const done = unlinkPages(h.pages, h.unlink, 4);
    await tick();
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
    await tick();
    expect(h.unlinks).toHaveLength(3);
    const pulledBefore = h.pulled.length;
    const boom = new Error('unlink 2 failed');
    h.unlinks[1]!.reject(boom);
    await tick();
    expect(outcome).toBe('pending');
    h.unlinks[0]!.resolve();
    await tick();
    expect(outcome).toBe('pending');
    h.unlinks[2]!.resolve();
    await done;
    expect(outcome).toBe(boom);
    expect(h.pulled.length).toBeLessThanOrEqual(pulledBefore + 1);
    expect(h.unlinks.length).toBeLessThanOrEqual(4);
  });

  it('rejects with the iterator error after the in-flight unlinks settle', async () => {
    const h = harness(10, 3);
    let outcome: unknown = 'pending';
    const done = unlinkPages(h.pages, h.unlink, 4).catch((e: unknown) => {
      outcome = e;
    });
    await tick();
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
