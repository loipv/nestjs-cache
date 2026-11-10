export class SingleFlight {
  private readonly inFlight = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<T>;

    const promise = (async () => task())();
    this.inFlight.set(key, promise);
    // Registered before any caller can attach a continuation, so the entry is
    // gone before a waiter may start a new run for the same key.
    const forget = (): void => {
      if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
    };
    promise.then(forget, forget);
    return promise;
  }
}
