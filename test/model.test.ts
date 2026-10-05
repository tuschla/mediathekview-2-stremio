import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collect, numberEpisodes, splitVersion } from '../src/model.ts';
import type { Film } from '../src/mvw.ts';

const MOVIE_TOPICS = /^(Filme|Filme in der ARD)$/i;

function film(channel: string, topic: string, title: string, timestamp: number): Film {
  return {
    channel,
    topic,
    title,
    description: '',
    timestamp,
    duration: 3600,
    url_website: '',
    url_video: `https://cdn.example/${encodeURIComponent(title)}/${timestamp}.mp4`,
    url_video_low: '',
    url_video_hd: '',
  };
}

test('only accessibility and language suffixes are versions', () => {
  assert.deepEqual(splitVersion('Duisburg Ruhrort (1981) (klare Sprache)'), { baseTitle: 'Duisburg Ruhrort (1981)', label: 'klare Sprache' });
  assert.deepEqual(splitVersion('Sterben (Originalversion mit Untertitel)'), { baseTitle: 'Sterben', label: 'Originalversion mit Untertitel' });
  assert.deepEqual(splitVersion('Erwartung(dan)'), { baseTitle: 'Erwartung', label: 'dan' });
  assert.deepEqual(splitVersion('Sternenkinder (2) (S18/E07)'), { baseTitle: 'Sternenkinder (2) (S18/E07)', label: 'Standard' });
  // Dash form, also before a season/episode marker and combined with a parenthetical.
  assert.deepEqual(splitVersion('Tatort: Im Abseits - Audiodeskription'), { baseTitle: 'Tatort: Im Abseits', label: 'Audiodeskription' });
  assert.deepEqual(splitVersion('Folge 38: Harter Stoff - Audiodeskription (S02/E38)'), {
    baseTitle: 'Folge 38: Harter Stoff (S02/E38)',
    label: 'Audiodeskription',
  });
  assert.deepEqual(splitVersion('Folge 125: Dein eigenes Leben (S03/E41) - Audiodeskription'), {
    baseTitle: 'Folge 125: Dein eigenes Leben (S03/E41)',
    label: 'Audiodeskription',
  });
  assert.deepEqual(splitVersion('Bürger und Corona  - Audiodeskription (mit Gebärdensprache)'), {
    baseTitle: 'Bürger und Corona',
    label: 'Audiodeskription, mit Gebärdensprache',
  });
  assert.deepEqual(splitVersion('Musik für taube Menschen | Wie geht das? | Audiodeskription'), {
    baseTitle: 'Musik für taube Menschen | Wie geht das?',
    label: 'Audiodeskription',
  });
  // Only the exact phrases: a subtitle mentioning a language is part of the title.
  assert.equal(splitVersion('Sebastian - Englische Rosen').label, 'Standard');
});

test('versions of one broadcast form one episode, also when filed under a version topic', () => {
  const t = 1_790_022_600;
  const { shows, movies } = collect(
    [
      film('ARD', 'Tatort', 'Donuts (Audiodeskription)', t),
      film('ARD', 'Tatort', 'Donuts', t),
      film('ARD', 'tagesschau', 'tagesschau 20:00 Uhr', t),
      film('ARD', 'tagesschau (mit Gebärdensprache)', 'tagesschau 20:00 Uhr', t),
    ],
    MOVIE_TOPICS,
  );
  assert.equal(movies.length, 0);
  assert.deepEqual(
    shows.map((s) => [s.ref.name, s.episodes.map((e) => [e.title, e.variants.map((v) => v.label)])]),
    [
      ['Tatort', [['Donuts', ['Standard', 'Audiodeskription']]]],
      ['tagesschau', [['tagesschau 20:00 Uhr', ['Standard', 'mit Gebärdensprache']]]],
    ],
  );
});

test('re-airings of an episode with a stated number are one episode', () => {
  const { shows } = collect(
    [film('ZDF', 'Der Bergdoktor', 'Schuld (1) (S16/E01)', 1_677_000_000), film('ZDF', 'Der Bergdoktor', 'Schuld (1) (S16/E01)', 1_743_000_000)],
    MOVIE_TOPICS,
  );
  assert.equal(shows[0]!.episodes.length, 1);
  assert.equal(shows[0]!.episodes[0]!.timestamp, 1_677_000_000);
});

test('ARTE: part markers form shows across the category topic; all other ARTE films are movies', () => {
  const { shows, movies } = collect(
    [
      film('ARTE.DE', 'Fernsehfilme und Serien - Serien', 'Mord im Mittsommer - Staffel 11 (3/3) - Fall 25: Amanda', 100),
      film('ARTE.DE', 'Fernsehfilme und Serien - Serien', 'Die Revoluzzer (4/8)', 200),
      film('ARTE.DE', 'Kino - Rund um den Film', "Worum geht's bei Brad Pitt? - Blow up", 250),
      film('ARTE.DE', 'Kino - Filme', 'Sterben', 300),
      film('ARD', 'Filme in der ARD', 'Zaun an Zaun', 400),
    ],
    MOVIE_TOPICS,
  );
  assert.deepEqual(
    shows.map((s) => [s.ref.name, s.episodes.map((e) => [e.stated?.season, e.stated?.number, e.title])]),
    [
      ['Die Revoluzzer', [[1, 4, 'Folge 4']]],
      ['Mord im Mittsommer', [[11, 3, 'Fall 25: Amanda']]],
    ],
  );
  assert.deepEqual(
    movies.map((m) => [m.baseTitle, m.genre]),
    [
      ['Zaun an Zaun', undefined],
      ['Sterben', 'Kino - Filme'],
      ["Worum geht's bei Brad Pitt? - Blow up", 'Kino - Rund um den Film'],
    ],
  );
});

test('episode numbers are unique and do not depend on which other episodes are available', () => {
  const friday = Date.UTC(2026, 8, 25, 18, 15) / 1000;
  const saturday = friday + 86_400;
  const films = [
    film('ZDF', 'Der Bergdoktor', 'Sternenkinder (1) (S18/E07)', friday),
    film('ZDF', 'Der Bergdoktor', 'Sternenkinder (Teil 2) (S18/E07)', saturday),
    film('ZDF', 'Der Bergdoktor', 'Weingut Wader (4) (S18/E04)', saturday),
    film('ZDF', 'Der Bergdoktor', 'Ohne Nummer', saturday + 3600),
    film('ZDF', 'Der Bergdoktor', 'Ohne Nummer, gleiche Minute', saturday + 3600),
    film('ZDF', 'Der Bergdoktor', 'Doppelt vergeben (S18/E08)', saturday + 7200),
    film('ZDF', 'Der Bergdoktor', 'Auch S18/E08 (S18/E08)', saturday + 10_800),
  ];
  const numbers = (fs: Film[]) =>
    new Map(numberEpisodes(collect(fs, MOVIE_TOPICS).shows[0]!.episodes).map(({ episode, season, number }) => [episode.title, [season, number]]));

  const all = numbers(films);
  // Part 1 keeps the stated number, later parts move to their own range.
  assert.deepEqual(all.get('Sternenkinder (1)'), [18, 7]);
  assert.deepEqual(all.get('Sternenkinder (Teil 2)'), [18, 10_072]);
  // "(4)" may count a series' films rather than parts; it is numbered like a part either way.
  assert.deepEqual(all.get('Weingut Wader (4)'), [18, 10_044]);
  // Unnumbered episodes use the broadcast minute (UTC) of the year.
  const minuteOfYear = (Date.UTC(2026, 8, 26, 19, 15) - Date.UTC(2026, 0, 1)) / 60_000;
  for (const title of ['Ohne Nummer', 'Ohne Nummer, gleiche Minute']) {
    const [season, number] = all.get(title)!;
    assert.deepEqual([season, Math.floor(number! / 4000)], [2026, minuteOfYear]);
  }
  // Episodes stating the same number move to a range of their own in the stated season.
  for (const title of ['Doppelt vergeben', 'Auch S18/E08']) {
    const [season, number] = all.get(title)!;
    assert.deepEqual([season, Math.floor(number! / 1000)], [18, 100_008]);
  }
  assert.equal(new Set([...all.values()].map(String)).size, films.length);
  for (const [, number] of all.values()) assert.ok(number! < 2 ** 31);

  // Losing any episode leaves every other episode's number unchanged, except that a stated number
  // stops being contested once only one claimant is left.
  for (let i = 0; i < 5; i++) {
    for (const [title, value] of numbers(films.toSpliced(i, 1))) assert.deepEqual(value, all.get(title), title);
  }

  // Versions filed later and re-airings merge into their episodes without moving any number.
  const week = 7 * 86_400;
  const withRepeats = numbers([
    ...films,
    film('ZDF', 'Der Bergdoktor', 'Ohne Nummer (Gebärdensprache)', saturday + 3600 + 300),
    film('ZDF', 'Der Bergdoktor', 'Doppelt vergeben (S18/E08)', saturday + week),
    film('ZDF', 'Der Bergdoktor', 'Sternenkinder (1) (S18/E07)', friday + week),
  ]);
  assert.deepEqual(withRepeats, all);
});

test('versions filed a few minutes apart and names differing in case still merge', () => {
  const t = 1_787_600_000;
  const { shows } = collect(
    [
      film('ARD', 'report München', 'Die Sendung vom 25.08.2026', t + 300),
      film('ARD', 'report München', 'Die Sendung vom 25.08.2026 (Audiodeskription)', t + 1100),
      film('ARD', 'report München', 'Die Sendung vom 25.08.2026 (Gebärdensprache)', t),
      film('ZDF', 'Unbubble', 'Folge A', t),
      film('ZDF', 'UNBUBBLE', 'Folge B', t + 60),
    ],
    MOVIE_TOPICS,
  );
  assert.deepEqual(
    shows.map((s) => [s.ref.name, s.episodes.map((e) => [e.title, e.variants.map((v) => v.label)])]),
    [
      ['report München', [['Die Sendung vom 25.08.2026', ['Standard', 'Audiodeskription', 'Gebärdensprache']]]],
      ['UNBUBBLE', [['Folge B', ['Standard']], ['Folge A', ['Standard']]]],
    ],
  );
});

test('different broadcasts with the same title and time are both kept', () => {
  const t = 1_786_809_600;
  const short = { ...film('ARD', 'Sportschau', 'Die Sportschau am Samstag', t), duration: 2679 };
  const long = { ...film('ARD', 'Sportschau', 'Die Sportschau am Samstag', t), duration: 6327, url_video: 'https://cdn.example/other.mp4' };
  const reListed = { ...short, url_video: 'https://cdn.example/mirror.mp4' };
  const [episode] = collect([short, long, reListed], MOVIE_TOPICS).shows[0]!.episodes;
  assert.deepEqual(
    episode!.variants.map((v) => v.label),
    ['Standard', 'Standard, 105 min'],
  );
});
