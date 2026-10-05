/** Stremio add-on protocol: https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/protocol.md */
import { TtlCache } from './cache.ts';
import { channelLabel, VERSION, type Config } from './config.ts';
import { decodeId, encodeId, ID_PREFIX, type ItemId } from './ids.ts';
import { findImage } from './images.ts';
import { collect, numberEpisodes, showKey, showKeyOf, STANDARD, type Collection, type Movie, type Show, type ShowRef, type Variant } from './model.ts';
import { MAX_PAGE_SIZE, MAX_RESULT_WINDOW, type Film, type MvwClient, type QueryField } from './mvw.ts';
import { UpstreamError } from './upstream.ts';

type MediaType = 'series' | 'movie';

interface CatalogDefinition {
  type: MediaType;
  id: string;
  name: string;
  /** Unset for the search catalogs. */
  channel?: string;
}

interface Meta {
  id: string;
  type: MediaType;
  name: string;
  poster: string;
  posterShape: 'landscape';
  background: string;
  genres: string[];
  releaseInfo: string;
  description?: string;
  released?: string;
  runtime?: string;
  videos?: Video[];
  /** Remux hides movies released within the past year that have no digital release date. */
  app_extras?: { releaseDates: { results: Array<{ iso_3166_1: string; release_dates: Array<{ release_date: string; type: number }> }> } };
}

interface Video {
  id: string;
  title: string;
  season: number;
  episode: number;
  released: string;
  overview: string;
  thumbnail: string;
}

interface Stream {
  name: string;
  url: string;
  behaviorHints: { bingeGroup: string; notWebReady: boolean };
}

interface Page {
  films: Film[];
  exhausted: boolean;
}

const MEDIA_TYPES: MediaType[] = ['series', 'movie'];

const CATALOG_PAGE_SIZE = 100;
/** Films fetched to find one movie; a title rarely repeats more than a few times per channel. */
const MOVIE_LOOKUP_SIZE = 200;
/** Films fetched per channel for a search. */
const SEARCH_SIZE = 300;
const MAX_SEARCH_TERM_LENGTH = 100;
const FAILURE_TTL_MS = 30_000;
const IMAGE_TTL_MS = 24 * 60 * 60_000;
const IMAGE_FAILURE_TTL_MS = 60_000;
/**
 * Films of past live events that link a live stream, which plays whatever is on now. On-demand HLS has
 * none of these markers.
 */
const LIVE_STREAM = /^https?:\/\/[^/]*(?:event|live)[^/]*\/|\/live\/|[/_]fs\//i;
const isLiveStream = ({ url_video }: Film) => /\.m3u8(?:\?|$)/i.test(url_video) && LIVE_STREAM.test(url_video);
/** Stremio's web player plays only HTTPS MP4 directly. */
const isWebReady = (url: string) => /^https:[^?#]*\.mp4(?:[?#]|$)/i.test(url);

/** Local overload is not an upstream failure and is not cached. */
const isTransient = (err: unknown) => !(err instanceof UpstreamError);

/** Cache weight: the films held, ~1.7 KB each. */
const countFilms = (items: Array<{ variants: Variant[] }>) => items.reduce((n, item) => n + item.variants.length, 0);

type MovieId = Extract<ItemId, { kind: 'movie' }>;
const isMovie = (id: MovieId) => (m: Movie) => m.channel === id.channel && m.topic === id.topic && m.timestamp === id.timestamp && m.baseTitle === id.baseTitle;

/** Lower-cased like showKey(), so an ID survives a change of spelling ("UNBUBBLE", "Unbubble"). */
const idRef = ({ channel, source, name }: ShowRef): ShowRef => ({ channel, source, name: name.toLowerCase() });
const imageUrl = (baseUrl: string, id: string) => `${baseUrl}/img/${id}.jpg`;

/** Canonical form, so that trivial variations of a term share one cache entry. */
function normalizeSearchTerm(term: string): string {
  return term
    .normalize('NFC')
    .replace(/[\p{Cc}\s]+/gu, ' ')
    .trim()
    .toLowerCase()
    .slice(0, MAX_SEARCH_TERM_LENGTH);
}

function preview(id: string, type: MediaType, name: string, genres: string[], baseUrl: string) {
  const image = imageUrl(baseUrl, id);
  return { id, type, name, genres, poster: image, background: image, posterShape: 'landscape' as const };
}

function showPreview({ ref, episodes }: Show, baseUrl: string): Meta {
  const first = new Date(episodes.at(-1)!.timestamp * 1000);
  return {
    ...preview(encodeId({ kind: 'show', ...idRef(ref) }), 'series', ref.name, [channelLabel(ref.channel)], baseUrl),
    // Open-ended: Remux stops refreshing series with a closed range.
    releaseInfo: `${first.getUTCFullYear()}-`,
  };
}

function videos({ ref, episodes }: Show, baseUrl: string): Video[] {
  return numberEpisodes(episodes).map(({ episode, season, number }) => {
    const id = encodeId({ kind: 'episode', ...idRef(ref), key: episode.key });
    return {
      id,
      title: episode.title,
      season,
      episode: number,
      released: new Date(episode.timestamp * 1000).toISOString(),
      overview: episode.variants[0]!.film.description,
      thumbnail: imageUrl(baseUrl, id),
    };
  });
}

function moviePreview({ channel, topic, genre, timestamp, baseTitle, variants }: Movie, baseUrl: string): Meta {
  const { film } = variants[0]!;
  const released = new Date(timestamp * 1000);
  const genres = genre ? [channelLabel(channel), genre] : [channelLabel(channel)];
  return {
    ...preview(encodeId({ kind: 'movie', channel, topic, timestamp, baseTitle }), 'movie', baseTitle, genres, baseUrl),
    releaseInfo: `${released.getUTCFullYear()}`,
    description: film.description,
    released: released.toISOString(),
    // Type 4 = digital release.
    app_extras: { releaseDates: { results: [{ iso_3166_1: 'DE', release_dates: [{ release_date: released.toISOString(), type: 4 }] }] } },
    runtime: `${Math.round(film.duration / 60)} min`,
  };
}

/** The requested catalog or item does not exist. */
export class NotFoundError extends Error {}

export class Addon {
  readonly #cfg: Config;
  readonly #mvw: MvwClient;
  readonly #catalogs: CatalogDefinition[];
  readonly #cacheMaxAge: number;
  // Separate caches, so that request-driven keys (searches, crafted IDs) cannot evict the catalogs.
  readonly #channels: TtlCache<Collection>;
  readonly #searches: TtlCache<Collection>;
  readonly #shows: TtlCache<Show | undefined>;
  readonly #movies: TtlCache<Movie[]>;
  readonly #images = new TtlCache<string | undefined>({ ttlMs: IMAGE_TTL_MS, failureTtlMs: IMAGE_FAILURE_TTL_MS, isTransient, maxEntries: 20_000 });

  constructor(cfg: Config, mvw: MvwClient) {
    this.#cfg = cfg;
    this.#mvw = mvw;
    this.#cacheMaxAge = cfg.cacheTtlMs / 1000;
    const ttl = { ttlMs: cfg.cacheTtlMs, failureTtlMs: FAILURE_TTL_MS, isTransient };
    this.#channels = new TtlCache({ ...ttl, maxEntries: cfg.channels.length });
    this.#searches = new TtlCache({
      ...ttl,
      maxEntries: 50,
      weigh: ({ shows, movies }) => countFilms(movies) + countFilms(shows.flatMap((show) => show.episodes)),
      maxWeight: 20_000,
    });
    this.#shows = new TtlCache({ ...ttl, maxEntries: 5000, weigh: (show) => countFilms(show?.episodes ?? []), maxWeight: 60_000 });
    this.#movies = new TtlCache<Movie[]>({ ...ttl, maxEntries: 5000, weigh: countFilms, maxWeight: 20_000 });
    this.#catalogs = [
      ...cfg.channels.flatMap((channel): CatalogDefinition[] => [
        { type: 'series', id: `${channel.toLowerCase()}.series`, name: `${channelLabel(channel)} Sendungen`, channel },
        { type: 'movie', id: `${channel.toLowerCase()}.movies`, name: `${channelLabel(channel)} Filme`, channel },
      ]),
      { type: 'series', id: 'search.series', name: 'Mediathek Suche' },
      { type: 'movie', id: 'search.movies', name: 'Mediathek Suche' },
    ];
  }

  manifest() {
    return {
      id: 'de.mediathekviewweb.stremio',
      version: VERSION,
      name: 'Mediathek',
      description: `Sendungen und Filme aus den Mediatheken (${this.#cfg.channels.map(channelLabel).join(', ')}) via MediathekViewWeb`,
      // Remux only honours idPrefixes declared per resource; without them it asks this add-on for
      // every IMDB/TMDB item in the library.
      resources: [
        'catalog',
        { name: 'meta', types: MEDIA_TYPES, idPrefixes: [ID_PREFIX] },
        { name: 'stream', types: MEDIA_TYPES, idPrefixes: [ID_PREFIX] },
      ],
      types: MEDIA_TYPES,
      idPrefixes: [ID_PREFIX],
      catalogs: this.#catalogs.map(({ type, id, name, channel }) => ({
        type,
        id,
        name,
        extra: channel ? [{ name: 'skip' }] : [{ name: 'search', isRequired: true }, { name: 'skip' }],
      })),
    };
  }

  async catalog(type: string, id: string, extra: URLSearchParams, baseUrl: string) {
    const catalog = this.#catalogs.find((c) => c.type === type && c.id === id);
    if (!catalog) throw new NotFoundError(`unknown catalog ${type}/${id}`);

    let shows: Show[];
    let movies: Movie[];
    if (catalog.channel) {
      ({ shows, movies } = await this.#channel(catalog.channel));
    } else {
      const term = normalizeSearchTerm(extra.get('search') ?? '');
      if (!term) return this.#reply({ metas: [] });
      ({ shows, movies } = await this.#search(term));
      // Items whose own name matches before items that only matched in an episode title.
      const rank = (name: string) => (name.toLowerCase().includes(term) ? 0 : 1);
      shows = shows.toSorted((a, b) => rank(a.ref.name) - rank(b.ref.name));
      movies = movies.toSorted((a, b) => rank(a.baseTitle) - rank(b.baseTitle));
    }

    const skip = Math.max(0, Number.parseInt(extra.get('skip') ?? '0', 10) || 0);
    const page = <T>(items: T[]) => items.slice(skip, skip + CATALOG_PAGE_SIZE);
    const metas =
      catalog.type === 'series'
        ? page(shows).map((show) => showPreview(show, baseUrl))
        : page(movies).map((movie) => moviePreview(movie, baseUrl));
    return this.#reply({ metas });
  }

  async meta(type: string, rawId: string, baseUrl: string) {
    const id = this.#decode(rawId);
    if (type === 'series' && id?.kind === 'show') {
      const show = await this.#show(id);
      if (show) return this.#reply({ meta: { ...showPreview(show, baseUrl), videos: videos(show, baseUrl) } });
    } else if (type === 'movie' && id?.kind === 'movie') {
      const movie = await this.#movie(id);
      if (movie) return this.#reply({ meta: moviePreview(movie, baseUrl) });
    }
    throw new NotFoundError(`no meta for ${type}/${rawId}`);
  }

  async stream(rawId: string) {
    // Not cached: the item may just not be available yet.
    const none = { streams: [], cacheMaxAge: 0 };
    const id = this.#decode(rawId);
    if (!id || id.kind === 'show') return none;
    const variants = await this.#variants(id);
    if (!variants) return none;

    const channel = channelLabel(id.channel);
    const streams = variants.flatMap(({ label, film }): Stream[] => {
      // Quality by URL; the first quality listing a URL keeps it.
      const qualities = new Map<string, string>();
      for (const [quality, url] of [['HD', film.url_video_hd], ['SD', film.url_video], ['Low', film.url_video_low]] as const) {
        if (url && !qualities.has(url)) qualities.set(url, quality);
      }
      return [...qualities].map(([url, quality]) => ({
        // Clients list streams by name, so it must tell versions apart.
        name: label === STANDARD ? `${channel} ${quality}` : `${channel} ${quality} · ${label}`,
        url,
        behaviorHints: { bingeGroup: `mediathek|${label}|${quality}`, notWebReady: !isWebReady(url) },
      }));
    });
    return this.#reply({ streams });
  }

  /**
   * Artwork of an item, from its broadcaster page. A catalog page requests all its posters at once, so
   * shows and movies are looked up in the cached catalogs first instead of one show query each.
   */
  async image(rawId: string): Promise<string | undefined> {
    const id = this.#decode(rawId);
    if (!id) return undefined;
    const variants = (id.kind === 'episode' ? undefined : await this.#listedVariants(id)) ?? (await this.#variants(id));
    const page = variants?.[0]?.film.url_website;
    if (!page) return undefined;
    return this.#images.get(page, () => findImage(page));
  }

  #reply<T extends object>(body: T): T & { cacheMaxAge: number } {
    return { ...body, cacheMaxAge: this.#cacheMaxAge };
  }

  #decode(rawId: string): ItemId | undefined {
    const id = decodeId(rawId);
    return id && this.#cfg.channels.includes(id.channel) ? id : undefined;
  }

  /** Versions of an episode or movie; for a show, of its newest episode. */
  async #variants(id: ItemId): Promise<Variant[] | undefined> {
    switch (id.kind) {
      case 'show':
        return (await this.#show(id))?.episodes[0]?.variants;
      case 'episode':
        return (await this.#show(id))?.episodes.find((e) => e.key === id.key)?.variants;
      case 'movie':
        return (await this.#movie(id))?.variants;
    }
  }

  /** Like #variants(), but only from the channel catalog and cached searches. */
  async #listedVariants(id: Exclude<ItemId, { kind: 'episode' }>): Promise<Variant[] | undefined> {
    const key = id.kind === 'show' ? showKey(id) : undefined;
    const find = ({ shows, movies }: Collection) =>
      id.kind === 'movie' ? movies.find(isMovie(id))?.variants : shows.find(({ ref }) => showKey(ref) === key)?.episodes[0]?.variants;
    for (const collection of [await this.#channel(id.channel), ...this.#searches.values()]) {
      const found = find(collection);
      if (found) return found;
    }
    return undefined;
  }

  /**
   * The show, from its newest `maxShowFilms` films. The query also matches other topics sharing the
   * show's words ("Terra X" matches "Terra Xplore"), so it pages until a page holds none of the show's
   * films.
   */
  #show(ref: ShowRef): Promise<Show | undefined> {
    const key = showKey(ref);
    const { movieTopics, maxShowFilms } = this.#cfg;
    return this.#shows.get(key, async () => {
      const films: Film[] = [];
      for (let offset = 0; offset < MAX_RESULT_WINDOW && films.length < maxShowFilms; offset += MAX_PAGE_SIZE) {
        const page = await this.#queryChannel(ref.channel, { fields: [ref.source], query: ref.name }, offset, MAX_PAGE_SIZE);
        const own = page.films.filter((film) => showKeyOf(film, movieTopics) === key);
        films.push(...own.slice(0, maxShowFilms - films.length));
        if (page.exhausted || own.length === 0) break;
      }
      return collect(films, movieTopics).shows[0];
    });
  }

  async #movie(id: MovieId): Promise<Movie | undefined> {
    // Keyed by the query alone, so that IDs differing only in topic or time share one lookup.
    const movies = await this.#movies.get(JSON.stringify([id.channel, id.baseTitle]), async () => {
      const { movies } = await this.#collect([this.#queryChannel(id.channel, { fields: ['title'], query: id.baseTitle }, 0, MOVIE_LOOKUP_SIZE)]);
      return movies.filter((m) => m.baseTitle === id.baseTitle);
    });
    return movies.find(isMovie(id));
  }

  /** Shows and movies among the channel's newest `catalogDepth` films. */
  #channel(channel: string): Promise<Collection> {
    const { catalogDepth } = this.#cfg;
    return this.#channels.get(channel, () => {
      const offsets = Array.from({ length: Math.ceil(catalogDepth / MAX_PAGE_SIZE) }, (_, i) => i * MAX_PAGE_SIZE);
      return this.#collect(offsets.map((offset) => this.#queryChannel(channel, undefined, offset, Math.min(MAX_PAGE_SIZE, catalogDepth - offset))));
    });
  }

  #search(term: string): Promise<Collection> {
    return this.#searches.get(term, () =>
      this.#collect(this.#cfg.channels.map((channel) => this.#queryChannel(channel, { fields: ['topic', 'title'], query: term }, 0, SEARCH_SIZE))),
    );
  }

  async #collect(pages: Array<Promise<Page>>): Promise<Collection> {
    return collect((await Promise.all(pages)).flatMap((page) => page.films), this.#cfg.movieTopics);
  }

  async #queryChannel(channel: string, field: QueryField | undefined, offset: number, size: number): Promise<Page> {
    const results = await this.#mvw.query({
      queries: [{ fields: ['channel.keyword'], query: channel }, ...(field ? [field] : [])],
      offset,
      size,
      minDuration: this.#cfg.minDuration,
    });
    return { films: results.filter((film) => !isLiveStream(film)), exhausted: results.length < size };
  }
}
