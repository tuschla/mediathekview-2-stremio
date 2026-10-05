/**
 * Groups MediathekView films into shows, episodes and movies.
 *
 * - Versions of a broadcast ("(Audiodeskription)", "- Gebärdensprache", "(dan)", …) are separate films,
 *   sometimes under their own topic ("tagesschau (mit Gebärdensprache)") or, for episodes, filed a few
 *   minutes apart. They become variants of one item.
 * - Non-ARTE channels: the topic is the show ("Tatort"), except movie-collection topics ("Filme").
 * - ARTE: the topic is a category ("Kino - Filme"). A title with a part marker, "Show (3/8)", is an
 *   episode of "Show"; everything else is a movie, since ARTE's other title schemes cannot be told
 *   apart from a single film.
 *
 * Classification depends only on the film itself, so a catalog and a later lookup of an item agree.
 */
import type { Film } from './mvw.ts';

export interface ShowRef {
  channel: string;
  /** Film field the name comes from and the show is queried by; see showSource(). */
  source: 'topic' | 'title';
  name: string;
}

/** Label of the regular version. */
export const STANDARD = 'Standard';

export interface Variant {
  /** STANDARD, "Audiodeskription", "Originalversion mit Untertitel", … */
  label: string;
  film: Film;
}

interface EpisodeNumber {
  season: number;
  number: number;
}

interface Item {
  /** First broadcast; re-airings lower it, folded stray versions do not. */
  timestamp: number;
  /** Title without version suffixes. */
  baseTitle: string;
  /** STANDARD first. */
  variants: Variant[];
}

interface Episode extends Item {
  /** Stated number and title, so re-airings merge; else broadcast time and title. */
  key: string;
  title: string;
  /** See statedNumber(). */
  stated?: EpisodeNumber;
}

export interface Movie extends Item {
  channel: string;
  /** Without version suffixes. */
  topic: string;
  /** ARTE category, e.g. "Kino - Filme". */
  genre?: string;
}

export interface Show {
  ref: ShowRef;
  /** Newest first. */
  episodes: Episode[];
}

export interface Collection {
  /** By newest episode, newest first. */
  shows: Show[];
  /** Newest first. */
  movies: Movie[];
}

/** A film's title and topic without version suffixes, its version label, and what it is. */
type Classification = { baseTitle: string; topic: string; label: string } & (
  | { kind: 'movie'; genre?: string }
  | { kind: 'episode'; show: ShowRef; title: string; stated?: EpisodeNumber }
);

const VERSION_WORDS =
  /audiodeskription|gebärdensprache|untertitel|originalversion|originalfassung|klare sprache|hörfassung|\bomu\b|\bov\b|englisch|english|französisch|spanisch|italienisch|dänisch|schwedisch|norwegisch|finnisch|polnisch|türkisch|japanisch|koreanisch|niederländisch|portugiesisch|russisch|ukrainisch|arabisch/i;
/** ISO 639-2 codes, only as the whole parenthetical: "Erwartung(dan)". */
const LANGUAGE_CODE = /^(?:deu|ger|eng|fra|fre|spa|ita|dan|swe|nor|fin|pol|tur|jpn|kor|nld|dut|por|rus|ukr|ara)$/i;
const TRAILING_PARENTHESES = /\s*\(([^()]*)\)\s*$/;
/** Dash or pipe form, "Donuts - Audiodeskription" or "… | Audiodeskription"; only these exact phrases. */
const TRAILING_VERSION_PHRASE =
  /\s+[-–|]\s+((?:mit |in )?(?:Audiodeskription|Gebärdensprache|Hörfassung|klarer? Sprache|Originalversion(?: mit Untertiteln?)?|OmU|OV))\s*$/i;
/** "Harter Stoff - Audiodeskription (S02/E37)". */
const TRAILING_SEASON_EPISODE = /\s*\(S\d+\/E\d+\)\s*$/;
/** At most four digits: larger numbers are data errors and would overflow the numbering ranges. */
const SEASON_EPISODE = /\s*\(S(\d{1,4})\/E(\d{1,4})\)/;
/** "Sternenkinder (2)", "Durch eisige Höhen (Teil 2)", "Auf Liebe und Tod (2): Untertitel". */
const EPISODE_PART = /\((?:Teil\s+)?(\d)\)(?=\s*(?:[:\-–]\s.*)?$)/;
const ARTE_PART = /^(.+?)(?:\s+-\s+Staffel\s+(\d{1,4}))?\s*\((\d{1,4})\/\d+\)(?:\s*[-–:]\s*(.+))?$/;
/** Part 2 of E07 is E10072. */
const LATER_PART_BASE = 10_000;
const VERSION_TIME_TOLERANCE_S = 15 * 60;

/**
 * Splits version suffixes off a title: "Donuts (Audiodeskription)" and "Donuts - Audiodeskription" →
 * "Donuts" + "Audiodeskription". A trailing season/episode marker stays.
 */
export function splitVersion(title: string): { baseTitle: string; label: string } {
  let baseTitle = title.trim();
  const marker = TRAILING_SEASON_EPISODE.exec(baseTitle);
  if (marker) baseTitle = baseTitle.slice(0, marker.index);
  const labels: string[] = [];
  for (;;) {
    const phrase = TRAILING_VERSION_PHRASE.exec(baseTitle);
    const parenthetical = phrase ? undefined : TRAILING_PARENTHESES.exec(baseTitle);
    const m = phrase ?? parenthetical;
    const label = m?.[1]!.trim();
    if (!m || !label || (parenthetical && !VERSION_WORDS.test(label) && !LANGUAGE_CODE.test(label))) break;
    labels.unshift(label);
    baseTitle = baseTitle.slice(0, m.index);
  }
  if (baseTitle === '') return { baseTitle: title.trim(), label: STANDARD };
  return { baseTitle: baseTitle + (marker?.[0].trimEnd() ?? ''), label: labels.join(', ') || STANDARD };
}

/**
 * Part 1 of a multi-part episode keeps the stated number; later parts move to a range no stated number
 * reaches. "(2)" may also count a series' films ("Weingut Wader (2) (S01/E02)"); a title cannot tell
 * which, so it is treated as a part either way.
 */
function statedNumber(title: string, season: number, episode: number): EpisodeNumber {
  const part = Number(EPISODE_PART.exec(title)?.[1] ?? 1);
  return { season, number: part === 1 ? episode : LATER_PART_BASE + episode * 10 + part };
}

function classify(film: Film, movieTopics: RegExp): Classification {
  const { baseTitle, label } = splitVersion(film.title);
  const { baseTitle: topic, label: topicLabel } = splitVersion(film.topic);
  const base = { baseTitle, topic, label: label === STANDARD ? topicLabel : label };

  if (showSource(film.channel) === 'title') {
    const part = ARTE_PART.exec(baseTitle);
    if (!part) return { ...base, kind: 'movie', genre: topic || undefined };
    const number = Number(part[3]);
    return {
      ...base,
      kind: 'episode',
      show: { channel: film.channel, source: 'title', name: part[1]!.trim().normalize('NFKC') },
      title: part[4]?.trim() || `Folge ${number}`,
      stated: { season: part[2] ? Number(part[2]) : 1, number },
    };
  }
  if (topic === '' || movieTopics.test(topic)) return { ...base, kind: 'movie' };

  // NFKC folds spelling variants such as "…" and "..." into one show.
  const show: ShowRef = { channel: film.channel, source: 'topic', name: topic.normalize('NFKC') };
  const m = SEASON_EPISODE.exec(baseTitle);
  if (!m) return { ...base, kind: 'episode', show, title: baseTitle };
  const episodeTitle = (baseTitle.slice(0, m.index) + baseTitle.slice(m.index + m[0].length)).trim() || baseTitle;
  return { ...base, kind: 'episode', show, title: episodeTitle, stated: statedNumber(episodeTitle, Number(m[1]), Number(m[2])) };
}

/** ARTE files shows under categories, so its show names come from the title. */
export function showSource(channel: string): ShowRef['source'] {
  return channel.startsWith('ARTE.') ? 'title' : 'topic';
}

/** Case-insensitive: "Unbubble" and "UNBUBBLE" are one show. */
export function showKey({ channel, source, name }: ShowRef): string {
  return JSON.stringify([channel, source, name.toLowerCase()]);
}

/** showKey() of the film's show; undefined for a movie. */
export function showKeyOf(film: Film, movieTopics: RegExp): string | undefined {
  const c = classify(film, movieTopics);
  return c.kind === 'episode' ? showKey(c.show) : undefined;
}

function upsert<K, V>(map: Map<K, V>, key: K, create: () => V): V {
  let value = map.get(key);
  if (value === undefined) map.set(key, (value = create()));
  return value;
}

/** Locale-independent, so every deployment orders alike. */
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byVariantLabel(a: Variant, b: Variant): number {
  if (a.label === b.label) return 0;
  if (a.label === STANDARD) return -1;
  if (b.label === STANDARD) return 1;
  return compareCodeUnits(a.label, b.label);
}

function byNewest(a: Item, b: Item): number {
  return b.timestamp - a.timestamp || compareCodeUnits(a.baseTitle, b.baseTitle);
}

function sortItems<T extends Item>(items: Iterable<T>): T[] {
  const list = [...items];
  for (const item of list) item.variants.sort(byVariantLabel);
  return list.sort(byNewest);
}

function addVariant(item: Item, film: Film, label: string): void {
  const existing = item.variants.find((v) => v.label === label);
  if (existing) {
    // Same length: a re-airing or duplicate listing of this version.
    if (Math.abs(existing.film.duration - film.duration) <= 0.1 * existing.film.duration) return;
    // Different length: another broadcast under the same title and time.
    label = `${label}, ${Math.round(film.duration / 60)} min`;
    if (item.variants.some((v) => v.label === label)) return;
  }
  item.variants.push({ label, film });
}

/**
 * Merges an unnumbered episode without a regular version into the regular one with the same title
 * broadcast within VERSION_TIME_TOLERANCE_S, e.g. a sign-language version filed five minutes earlier.
 */
function foldStrayVersions(episodes: Map<string, Episode>): void {
  const isRegular = (e: Episode) => !e.stated && e.variants.some((v) => v.label === STANDARD);
  const regular = [...episodes.values()].filter(isRegular);
  for (const [key, stray] of episodes) {
    if (stray.stated || isRegular(stray)) continue;
    const target = regular.find(
      (e) => e.baseTitle === stray.baseTitle && Math.abs(e.timestamp - stray.timestamp) <= VERSION_TIME_TOLERANCE_S,
    );
    if (!target) continue;
    for (const { label, film } of stray.variants) addVariant(target, film, label);
    episodes.delete(key);
  }
}

export function collect(films: Film[], movieTopics: RegExp): Collection {
  const shows = new Map<string, { ref: ShowRef; refTimestamp: number; episodes: Map<string, Episode> }>();
  const movies = new Map<string, Movie>();

  for (const film of films) {
    const c = classify(film, movieTopics);
    const { baseTitle, topic, label } = c;

    if (c.kind === 'movie') {
      const movie = upsert(movies, JSON.stringify([film.channel, topic, film.timestamp, baseTitle]), () => ({
        channel: film.channel,
        topic,
        genre: c.genre,
        timestamp: film.timestamp,
        baseTitle,
        variants: [],
      }));
      addVariant(movie, film, label);
      continue;
    }

    const show = upsert(shows, showKey(c.show), () => ({ ref: c.show, refTimestamp: film.timestamp, episodes: new Map() }));
    if (film.timestamp > show.refTimestamp) {
      // The newest film gives the show its displayed spelling.
      show.ref = c.show;
      show.refTimestamp = film.timestamp;
    }
    const key = JSON.stringify(c.stated ? [c.stated.season, c.stated.number, baseTitle] : [film.timestamp, baseTitle]);
    const episode = upsert(show.episodes, key, () => ({ key, timestamp: film.timestamp, baseTitle, title: c.title, stated: c.stated, variants: [] }));
    // Only re-airings of a numbered episode differ in time.
    episode.timestamp = Math.min(episode.timestamp, film.timestamp);
    addVariant(episode, film, label);
  }

  const showList = [...shows.values()].map(({ ref, episodes }) => {
    foldStrayVersions(episodes);
    return { ref, episodes: sortItems(episodes.values()) };
  });
  showList.sort((a, b) => byNewest(a.episodes[0]!, b.episodes[0]!) || compareCodeUnits(a.ref.name, b.ref.name));
  return { shows: showList, movies: sortItems(movies.values()) };
}

/** FNV-1a hash of the title, shifted by `offset` to probe past a taken slot. */
function titleSlot(title: string, offset: number, slots: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < title.length; i++) h = Math.imul(h ^ title.charCodeAt(i), 0x01000193);
  return ((h >>> 0) + offset) % slots;
}

/**
 * Title slots per minute. The largest number, 527,040 minutes of a leap year × 4000, stays below 2^31:
 * Jellyfin clients use 32-bit episode numbers.
 */
const SLOTS_PER_MINUTE = 4000;
/**
 * Episodes stating the same number get CONTESTED_BASE + stated × CONTESTED_SLOTS + title slot. Stated
 * numbers stay below 110,000 (four digits plus parts), so this stays below 2^31 too.
 */
const CONTESTED_BASE = 100_000_000;
const CONTESTED_SLOTS = 1000;

/** Season = broadcast year, episode = minute of the year and title slot. UTC: Berlin time repeats an hour in autumn. */
function dateNumber(timestamp: number, offset: number, baseTitle: string): EpisodeNumber {
  const date = new Date(timestamp * 1000);
  const year = date.getUTCFullYear();
  const minute = Math.floor((date.getTime() - Date.UTC(year, 0, 1)) / 60_000);
  return { season: year, number: minute * SLOTS_PER_MINUTE + titleSlot(baseTitle, offset, SLOTS_PER_MINUTE) };
}

function contestedNumber({ season, number }: EpisodeNumber, offset: number, baseTitle: string): EpisodeNumber {
  return { season, number: CONTESTED_BASE + number * CONTESTED_SLOTS + titleSlot(baseTitle, offset, CONTESTED_SLOTS) };
}

const numberKey = ({ season, number }: EpisodeNumber) => `${season}:${number}`;

/**
 * Season and episode numbers, oldest episode first. Clients key watch state by these numbers, so each
 * number is derived from its episode alone (stated number, else broadcast time) and stays put while
 * other episodes come and go.
 */
export function numberEpisodes(episodes: Episode[]): Array<{ episode: Episode } & EpisodeNumber> {
  const claims = Map.groupBy(episodes.filter((e) => e.stated), (e) => numberKey(e.stated!));
  const used = new Set<string>();
  // Key order, so which of two colliding episodes probes on does not depend on broadcast times.
  const numbered = episodes.toSorted((a, b) => compareCodeUnits(a.key, b.key)).map((episode) => {
    const { stated, timestamp, baseTitle } = episode;
    let assigned = stated && claims.get(numberKey(stated))!.length === 1 ? stated : undefined;
    for (let offset = 0; !assigned || used.has(numberKey(assigned)); offset++) {
      assigned = stated ? contestedNumber(stated, offset, baseTitle) : dateNumber(timestamp, offset, baseTitle);
    }
    used.add(numberKey(assigned));
    return { episode, ...assigned };
  });
  return numbered.sort((a, b) => a.episode.timestamp - b.episode.timestamp || compareCodeUnits(a.episode.baseTitle, b.episode.baseTitle));
}
