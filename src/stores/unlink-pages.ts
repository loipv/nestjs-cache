/**
 * Deletes every page of keys with at most `concurrency` unlinks in flight, so the scan overlaps
 * the deletes. When the window is full it waits for the oldest unlink. An unlink failure stops
 * the scan (the iterator is closed), waits for the unlinks in flight and rejects with the first
 * unlink error; an iterator failure waits for them, then rejects with the iterator's error, or
 * with the first unlink error if one of them failed too. Empty pages send nothing.
 */
export async function unlinkPages(
  pages: AsyncIterable<string[]>,
  unlink: (keys: string[]) => Promise<void>,
  concurrency: number,
): Promise<void> {
  const inflight: Promise<void>[] = [];
  const state: { failed: boolean; failure: unknown } = { failed: false, failure: undefined };
  const iterator = pages[Symbol.asyncIterator]();

  const hasFailed = (): boolean => state.failed;

  const settleAll = async (): Promise<void> => {
    await Promise.all(inflight);
    inflight.length = 0;
  };

  try {
    while (!hasFailed()) {
      let step: IteratorResult<string[]>;
      try {
        step = await iterator.next();
      } catch (error) {
        await settleAll();
        // When an in-flight unlink failed too, its error wins over the iterator's.
        throw hasFailed() ? state.failure : error;
      }
      if (step.done === true || hasFailed()) break;
      const keys = step.value;
      if (keys.length === 0) continue;
      if (inflight.length >= concurrency) {
        await inflight.shift();
        if (hasFailed()) break;
      }
      // Each tracked promise never rejects, so an in-flight unlink cannot surface as an unhandled
      // rejection.
      inflight.push(
        new Promise<void>((resolve) => {
          resolve(unlink(keys));
        }).then(undefined, (error: unknown) => {
          if (!state.failed) {
            state.failed = true;
            state.failure = error;
          }
        }),
      );
    }
  } finally {
    if (hasFailed()) {
      try {
        await iterator.return?.();
      } catch {
        // the unlink error is the one to report
      }
    }
  }
  await settleAll();
  if (state.failed) throw state.failure;
}
