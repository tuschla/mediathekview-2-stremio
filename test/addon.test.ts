import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Addon, NotFoundError } from '../src/addon.ts';
import { loadConfig } from '../src/config.ts';
import { decodeId, encodeId } from '../src/ids.ts';
import type { Film, MvwClient, Query } from '../src/mvw.ts';

const BASE = 'http://addon';
const DAY = 86_400;
const now = Math.floor(Date.now() / 1000);

function film(channel: string, topic: string, title: string, timestamp: number, url_video = `https://cdn.example/${timestamp}.mp4`): Film {
  return { channel, topic, title, description: '', timestamp, duration: 3600, url_website: '', url_video, url_video_low: '', url_video_hd: '' };
}

/** Answers queries from a fixed film list the way the API does: token matches, newest first. */
function fakeApi(films: Film[]) {
  const api = {
    queries: 0,
    async query({ queries, offset, size }: Query): Promise<Film[]> {
      api.queries++;
      const matches = (f: Film) =>
        queries.every(({ fields, query }) =>
          fields.some((field) => (field === 'channel.keyword' ? f.channel === query : f[field].toLowerCase().includes(query.toLowerCase()))),
        );
      return films
        .filter(matches)
        .toSorted((a, b) => b.timestamp - a.timestamp)
        .slice(offset, offset + size);
    },
  };
  return api;
}

function addon(films: Film[]) {
  const api = fakeApi(films);
  return { api, addon: new Addon(loadConfig({ CHANNELS: 'ARD,ZDF,ORF' }), api as unknown as MvwClient) };
}

test('a show keeps its ID when the spelling of its name changes', async () => {
  const older = addon([film('ZDF', 'UNBUBBLE', 'Folge A', now - 7 * DAY)]);
  const [before] = (await older.addon.catalog('series', 'zdf.series', new URLSearchParams(), BASE)).metas;
  const newer = addon([film('ZDF', 'UNBUBBLE', 'Folge A', now - 7 * DAY), film('ZDF', 'Unbubble', 'Folge B', now - DAY)]);
  const [after] = (await newer.addon.catalog('series', 'zdf.series', new URLSearchParams(), BASE)).metas;
  assert.equal(after!.name, 'Unbubble');
  assert.equal(after!.id, before!.id);
  const { meta } = await newer.addon.meta('series', before!.id, BASE);
  assert.equal(meta.id, before!.id);
  assert.deepEqual(
    meta.videos!.map((v) => v.title),
    ['Folge A', 'Folge B'],
  );
});

test('running shows are not reported as ended, movies carry a digital release date', async () => {
  const { addon: a } = addon([
    film('ARD', 'Tatort', 'Alt', Date.UTC(2020, 5, 1) / 1000),
    film('ARD', 'Tatort', 'Neu', now - DAY),
    film('ARD', 'Filme im Ersten', 'Zaun an Zaun', now - DAY),
  ]);
  const [show] = (await a.catalog('series', 'ard.series', new URLSearchParams(), BASE)).metas;
  assert.equal(show!.releaseInfo, '2020-');
  const [movie] = (await a.catalog('movie', 'ard.movies', new URLSearchParams(), BASE)).metas;
  const dates = movie!.app_extras!.releaseDates.results.flatMap((r) => r.release_dates);
  assert.ok(dates.some((d) => d.type >= 4 && d.release_date === movie!.released));
});

test('films linking a live channel are left out, on-demand HLS is kept', async () => {
  const { addon: a } = addon([
    film('ARD', 'Sportschau', 'Bundesliga', now - DAY, 'https://wdr-live.ard-mcdn.de/wdr/live/hls/de/master-720p-3200.m3u8'),
    film('ARD', 'Sportschau', 'Triathlon', now - DAY, 'https://sportschau-event.ard-mcdn.de/sportschau/event04/hls/de/master720p3200.m3u8'),
    film('ARD', 'Sportschau', 'Handball', now - DAY, 'https://mcdn.ndr.de/ndr/hls/ndr_fs/ndr_mv/master_720.m3u8'),
    film('ORF', 'Soko Linz', 'Folge 4', now - DAY, 'https://apasfiis.sf.apa.at/ipad/cms-austria/2026/09/29/Soko-Linz.mp4/chunklist_b4165000.m3u8'),
  ]);
  assert.deepEqual((await a.catalog('series', 'ard.series', new URLSearchParams(), BASE)).metas, []);
  assert.equal((await a.catalog('series', 'orf.series', new URLSearchParams(), BASE)).metas.length, 1);
});

test('streams list each URL once and are named so that versions can be told apart', async () => {
  const t = now - DAY;
  const { addon: a } = addon([
    {
      ...film('ZDF', 'Terra X', 'Folge A', t, 'https://cdn.example/a.mp4'),
      url_video_hd: 'https://cdn.example/a.mp4',
      url_video_low: 'http://cdn.example/a-low.mp4',
    },
    film('ZDF', 'Terra X', 'Folge A (Audiodeskription)', t, 'https://cdn.example/a-ad.m3u8'),
  ]);
  const [show] = (await a.catalog('series', 'zdf.series', new URLSearchParams(), BASE)).metas;
  const { meta } = await a.meta('series', show!.id, BASE);
  const { streams } = await a.stream(meta.videos![0]!.id);
  assert.deepEqual(
    streams.map(({ name, url, behaviorHints }) => [name, url, behaviorHints.notWebReady]),
    [
      ['ZDF HD', 'https://cdn.example/a.mp4', false],
      ['ZDF Low', 'http://cdn.example/a-low.mp4', true],
      ['ZDF SD · Audiodeskription', 'https://cdn.example/a-ad.m3u8', true],
    ],
  );
});

test('posters of catalog items need no API queries of their own', async () => {
  const films = Array.from({ length: 50 }, (_, i) => film('ARD', `Show ${i}`, `Folge ${i}`, now - i * 3600));
  films.push(film('ARD', 'Filme im Ersten', 'Ein Film', now - DAY));
  const { api, addon: a } = addon(films);
  const series = (await a.catalog('series', 'ard.series', new URLSearchParams(), BASE)).metas;
  const movies = (await a.catalog('movie', 'ard.movies', new URLSearchParams(), BASE)).metas;
  const queries = api.queries;
  await Promise.all([...series, ...movies].map((m) => a.image(m.id)));
  assert.equal(api.queries, queries);
});

test('movie IDs differing only in topic or time share one lookup', async () => {
  const t = now - DAY;
  const { api, addon: a } = addon([film('ARD', 'Filme im Ersten', 'Zaun an Zaun', t)]);
  const [movie] = (await a.catalog('movie', 'ard.movies', new URLSearchParams(), BASE)).metas;
  const queries = api.queries;
  const { meta } = await a.meta('movie', movie!.id, BASE);
  assert.equal(meta.name, 'Zaun an Zaun');
  const id = decodeId(movie!.id);
  assert.ok(id?.kind === 'movie');
  for (let i = 1; i <= 20; i++) {
    await assert.rejects(a.meta('movie', encodeId({ ...id, timestamp: t + i }), BASE), NotFoundError);
  }
  assert.equal(api.queries, queries + 1);
});

test('show lookups page on past pages that only repeat known episodes', async () => {
  const films: Film[] = [];
  let t = now;
  const add = (topic: string, title: string) => films.push(film('ZDF', topic, title, (t -= 60)));
  const episode = (n: number) => add('Terra X', `Folge ${n} (S01/E${n})`);
  // The topic query also matches "Terra Xplore". Page 2 holds only re-airings of page 1's episodes.
  for (let n = 1; n <= 500; n++) {
    episode(n);
    add('Terra Xplore', `Clip ${n}`);
  }
  for (let n = 1; n <= 100; n++) episode(n);
  for (let n = 101; n <= 1000; n++) add('Terra Xplore', `Clip ${n}`);
  for (let n = 501; n <= 800; n++) episode(n);
  const { addon: a } = addon(films);
  const { meta } = await a.meta('series', encodeId({ kind: 'show', channel: 'ZDF', source: 'topic', name: 'terra x' }), BASE);
  assert.equal(meta.videos!.length, 800);
});
