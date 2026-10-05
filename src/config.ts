import pkg from '../package.json' with { type: 'json' };

export const VERSION = pkg.version;
export const USER_AGENT = `mediathek-stremio-addon/${VERSION}`;

export interface Config {
  host: string;
  port: number;
  /** Base URL clients use to reach the add-on; the request's Host header is used when unset. */
  publicUrl: string | undefined;
  /** Exact MediathekView channel names, e.g. "ARD", "ZDF", "ARTE.DE". */
  channels: string[];
  /** Films shorter than this many seconds (trailers, clips) are ignored. */
  minDuration: number;
  /** Number of newest films per channel the browse catalogs are built from. */
  catalogDepth: number;
  /** Maximum number of a show's films looked up, newest first. */
  maxShowFilms: number;
  /** Topics of non-ARTE channels whose films are movies rather than episodes of one show. */
  movieTopics: RegExp;
  cacheTtlMs: number;
  maxConcurrentRequests: number;
}

const DEFAULT_MOVIE_TOPICS =
  '^(Filme|Filme in der ARD|Filme im Ersten|Spielfilme?|Spielfilm-Highlights|Fernsehfilme?|Kinofilme?|Das kleine Fernsehspiel)$';

function readInt(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max = Infinity): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}, got "${raw}"`);
  }
  return value;
}

function readPublicUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const url = URL.parse(raw);
  if (url?.protocol !== 'http:' && url?.protocol !== 'https:') throw new Error(`PUBLIC_URL must be an http(s) URL, got "${raw}"`);
  return url.href.replace(/\/+$/, '');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const channels = (env.CHANNELS ?? 'ARD,ZDF,ARTE.DE')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
  if (channels.length === 0) throw new Error('CHANNELS must list at least one channel');

  return {
    host: env.HOST ?? '0.0.0.0',
    port: readInt(env, 'PORT', 7000, 1, 65535),
    publicUrl: readPublicUrl(env.PUBLIC_URL),
    channels,
    minDuration: readInt(env, 'MIN_DURATION', 300, 0),
    // 10,000: the API's result window.
    catalogDepth: readInt(env, 'CATALOG_DEPTH', 2000, 1, 10_000),
    maxShowFilms: readInt(env, 'MAX_SHOW_FILMS', 1000, 1, 10_000),
    movieTopics: new RegExp(env.MOVIE_TOPICS ?? DEFAULT_MOVIE_TOPICS, 'i'),
    cacheTtlMs: readInt(env, 'CACHE_TTL_MINUTES', 30, 1) * 60_000,
    maxConcurrentRequests: readInt(env, 'MAX_CONCURRENT_REQUESTS', 4, 1),
  };
}

/** Display name of a MediathekView channel. */
export function channelLabel(channel: string): string {
  return channel === 'ARTE.DE' ? 'ARTE' : channel;
}
