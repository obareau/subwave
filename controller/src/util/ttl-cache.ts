// A TTL cache around one async producer, with single-flight coalescing.
//
// For a reading that is CHEAP to be slightly stale but EXPENSIVE (or noisy) to
// take: the Liquidsoap telnet status is the motivating case — `GET /settings`
// opened a fresh telnet connection on every request, and the admin UI polls that
// endpoint every 3s, so radio.liq logged a `New client` / `disconnected` pair
// forever for anyone with an admin tab open (issue #1300, bug 16b).
//
// Two properties, both load-bearing:
//   • TTL — a reading younger than ttlMs is served from memory, so the cost is
//     bounded by the clock rather than by how many clients are polling.
//   • single flight — concurrent callers during an in-flight take share the ONE
//     promise instead of racing each other into parallel connections. This is
//     the same coalescing the Icecast status poll uses (#1256), where racing
//     cadences were turning into spurious AbortErrors.
//
// A rejection is NOT cached: the in-flight promise is dropped and the error
// propagates to every waiter, so the next call retries. Stale values are never
// served in place of an error either — the caller decides what a failed take
// means, exactly as it did before the cache existed.
//
// Pure except for the clock, which is injectable — see scripts/ttl-cache.test.ts.

export interface CachedAsync<T> {
  /** Cached value if fresh, else take a new one (coalescing concurrent calls). */
  get(): Promise<T>;
  /** The cached entry as-is, without ever taking a new reading. null when
   *  empty. NOT TTL-checked — an expired entry is still returned, so a caller
   *  that cares about freshness must compare `at` itself. Only get() honours
   *  the TTL. */
  peek(): { value: T; at: number } | null;
  /** Drop the cached value so the next get() takes a fresh reading. Call this
   *  after any action that CHANGES what the producer would report. */
  invalidate(): void;
}

export interface CachedAsyncOptions {
  ttlMs: number;
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number;
}

export function cachedAsync<T>(fn: () => Promise<T>, { ttlMs, now = Date.now }: CachedAsyncOptions): CachedAsync<T> {
  let entry: { value: T; at: number } | null = null;
  let inFlight: Promise<T> | null = null;

  return {
    peek: () => entry,

    invalidate() {
      entry = null;
      // A take already in flight is left alone: it was started before the
      // change and its result would be stale, so it must not become the cached
      // entry. The `take === inFlight` guard below is what drops it.
      inFlight = null;
    },

    get(): Promise<T> {
      if (entry && now() - entry.at < ttlMs) return Promise.resolve(entry.value);
      if (inFlight) return inFlight;

      const take = fn().then(
        value => {
          // Only the take that is still the current one may publish. An
          // invalidate() during the take means this reading predates a known
          // change — return it to this caller, but don't cache it.
          if (take === inFlight) {
            entry = { value, at: now() };
            inFlight = null;
          }
          return value;
        },
        err => {
          if (take === inFlight) inFlight = null;
          throw err;
        },
      );
      inFlight = take;
      return take;
    },
  };
}
