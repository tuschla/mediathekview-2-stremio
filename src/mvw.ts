/** Client for the MediathekViewWeb search API (https://mediathekviewweb.de). */
import { Upstream, UpstreamError } from './upstream.ts';

/** A film, reduced to the fields this add-on uses. */
export interface Film {
  channel: string;
  topic: string;
  title: string;
  description: string;
  /** Broadcast time, Unix seconds. */
  timestamp: number;
  /** Seconds. */
  duration: number;
  url_website: string;
  url_video: string;
  url_video_low: string;
  url_video_hd: string;
}

export interface QueryField {
  /** `channel.keyword` matches exactly; the others match word prefixes. */
  fields: Array<'channel.keyword' | 'topic' | 'title'>;
  query: string;
}

export interface Query {
  /** Entries with different field sets must all match; the API ORs entries with the same field set. */
  queries: QueryField[];
  offset: number;
  size: number;
  minDuration: number;
}

interface ApiResponse {
  err: unknown;
  result: { results: Film[] } | null;
}

const API_URL = 'https://mediathekviewweb.de/api/query';
export const MAX_PAGE_SIZE = 1000;
/** The API rejects queries reaching past this many results. */
export const MAX_RESULT_WINDOW = 10_000;

/**
 * The API's query tokenizer splits words at anything but [a-zA-Z0-9], so letters are spelled here the way
 * its index maps or folds them; expanding "ä" to "ae" also makes the 25-character cut count it right.
 */
const FOLD: Record<string, string> = {
  ä: 'ae', ö: 'oe', ü: 'ue', Ä: 'Ae', Ö: 'Oe', Ü: 'Ue', ß: 'ss', ẞ: 'SS', æ: 'ae', Æ: 'Ae', œ: 'oe', Œ: 'Oe', ø: 'o', Ø: 'O',
  ł: 'l', Ł: 'L', đ: 'd', Đ: 'D', ð: 'd', Ð: 'D', þ: 'th', Þ: 'Th', ı: 'i', ħ: 'h', Ħ: 'H',
};

/** Query text spelled like the API's index: [a-zA-Z0-9] words, "&" read as "und", prefixes of at most 25 characters. */
export function queryText(text: string): string {
  return text
    .normalize('NFC')
    .replaceAll('&', 'und')
    .replace(/[^\0-\x7f]/g, (ch) => FOLD[ch] ?? ch.normalize('NFD').replace(/\p{M}/gu, ''))
    .replace(/[a-z0-9]{26,}/gi, (word) => word.slice(0, 25));
}

/** Cached films dominate memory; API records carry several more fields. */
function toFilm(r: Film): Film {
  return {
    channel: r.channel,
    topic: r.topic,
    title: r.title,
    description: r.description,
    timestamp: r.timestamp,
    duration: r.duration,
    url_website: r.url_website,
    url_video: r.url_video,
    url_video_low: r.url_video_low,
    url_video_hd: r.url_video_hd,
  };
}

export class MvwClient {
  readonly #upstream: Upstream;

  constructor(concurrency: number) {
    this.#upstream = new Upstream({ concurrency, queueTimeoutMs: 10_000, requestTimeoutMs: 20_000 });
  }

  /** Films newest first. `future: false` still returns films up to an hour ahead; they are often online already. */
  query({ queries, offset, size, minDuration }: Query): Promise<Film[]> {
    const body = JSON.stringify({
      queries: queries.map(({ fields, query }) => ({ fields, query: queryText(query) })),
      sortBy: 'timestamp',
      sortOrder: 'desc',
      future: false,
      offset,
      size,
      // Exclusive bound; durations are whole seconds.
      duration_min: minDuration ? minDuration - 1 : undefined,
    });
    return this.#upstream.fetch(API_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body }, async (res) => {
      if (!res.ok) throw new UpstreamError(`MediathekViewWeb responded ${res.status}`);
      const { err, result } = (await res.json()) as ApiResponse;
      if (err || !result) throw new UpstreamError(`MediathekViewWeb error: ${JSON.stringify(err)}`);
      return result.results.map(toFilm);
    });
  }
}
