interface Entry<V> {
  expires: number;
  value: Promise<V>;
  /** Weight of `lastGood`. */
  weight: number;
  /** Served when a reload fails. */
  lastGood?: { value: V };
}

interface CacheOptions<V> {
  ttlMs: number;
  maxEntries: number;
  /** Bound on the summed weight of all entries, e.g. the films they hold. */
  maxWeight?: number;
  weigh?: (value: V) => number;
  failureTtlMs: number;
  /** Failures that are not cached at all, e.g. local overload. */
  isTransient?: (err: unknown) => boolean;
}

/**
 * TTL cache for async loads with least-recently-used eviction.
 *
 * - Concurrent lookups of a key share one load.
 * - Failures are cached for `failureTtlMs`, so an outage costs one load per key and window.
 * - A failed reload serves the previous value.
 */
export class TtlCache<V> {
  readonly #options: Required<CacheOptions<V>>;
  readonly #entries = new Map<string, Entry<V>>();
  #weight = 0;

  constructor(options: CacheOptions<V>) {
    this.#options = { maxWeight: Infinity, weigh: () => 0, isTransient: () => false, ...options };
  }

  get(key: string, load: () => Promise<V>): Promise<V> {
    const cached = this.#entries.get(key);
    if (cached && cached.expires > Date.now()) {
      // Map order is insertion order: re-inserting marks the key most recently used.
      this.#entries.delete(key);
      this.#entries.set(key, cached);
      return cached.value;
    }

    const entry = { expires: Date.now() + this.#options.ttlMs, weight: cached?.weight ?? 0, lastGood: cached?.lastGood } as Entry<V>;
    entry.value = this.#load(key, entry, load);
    this.#remove(key);
    this.#entries.set(key, entry);
    this.#weight += entry.weight;
    this.#evict();
    return entry.value;
  }

  async #load(key: string, entry: Entry<V>, load: () => Promise<V>): Promise<V> {
    const isStored = () => this.#entries.get(key) === entry;
    try {
      const value = await load();
      entry.lastGood = { value };
      if (isStored()) {
        const weight = this.#options.weigh(value);
        this.#weight += weight - entry.weight;
        entry.weight = weight;
        this.#evict();
      }
      return value;
    } catch (err) {
      const transient = this.#options.isTransient(err);
      entry.expires = transient ? 0 : Date.now() + this.#options.failureTtlMs;
      if (!entry.lastGood) {
        if (transient && isStored()) this.#remove(key);
        throw err;
      }
      console.warn(`serving stale ${JSON.stringify(key)}: ${err}`);
      return entry.lastGood.value;
    }
  }

  /** Loaded values, expired ones included, without loading or touching the eviction order. */
  *values(): Generator<V> {
    for (const { lastGood } of this.#entries.values()) if (lastGood) yield lastGood.value;
  }

  #remove(key: string): void {
    const entry = this.#entries.get(key);
    if (!entry) return;
    this.#weight -= entry.weight;
    this.#entries.delete(key);
  }

  #evict(): void {
    const { maxEntries, maxWeight } = this.#options;
    for (const key of this.#entries.keys()) {
      if (this.#entries.size <= maxEntries && this.#weight <= maxWeight) break;
      this.#remove(key);
    }
  }
}
