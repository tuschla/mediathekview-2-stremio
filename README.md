# Mediathek Stremio add-on

English · [Deutsch](README.de.md)

Stremio add-on for the German public-broadcaster Mediatheken (default: ARD, ZDF, ARTE), served live from the
[MediathekViewWeb](https://mediathekviewweb.de) API. Works with any Stremio-protocol client.

- Series grouped by topic ("Tatort"); ARTE series by "(n/m)" part markers.
- Movies from movie-collection topics ("Filme im Ersten", …) and all other ARTE programmes.
- Audiodeskription, Gebärdensprache and language versions become extra streams of one item.
- Artwork from the broadcaster page; search across the configured channels.

## Run

```sh
docker run -d -p 127.0.0.1:7000:7000 --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  ghcr.io/tuschla/mediathekview-2-stremio
```

or `node src/server.ts` (Node.js ≥ 22.18). Manifest: `http://<host>:7000/manifest.json`

There is no authentication or rate limiting, and uncached requests query MediathekViewWeb. Keep the port private
or put a rate-limiting reverse proxy in front.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `7000` / `0.0.0.0` | Listen address |
| `PUBLIC_URL` | request `Host` | Base URL of image links; set it behind a reverse proxy |
| `CHANNELS` | `ARD,ZDF,ARTE.DE` | MediathekView channel names, e.g. `3Sat`, `BR`, `WDR`, `ZDFinfo` |
| `MIN_DURATION` | `300` | Ignore films shorter than this many seconds |
| `CATALOG_DEPTH` | `2000` | Newest films per channel the catalogs are built from (max 10000) |
| `MAX_SHOW_FILMS` | `1000` | Newest films of a show listed as episodes (max 10000) |
| `MOVIE_TOPICS` | see `src/config.ts` | Regex of non-ARTE topics that are movie collections |
| `CACHE_TTL_MINUTES` | `30` | Cache lifetime of API results |
| `MAX_CONCURRENT_REQUESTS` | `4` | Parallel MediathekViewWeb requests |

## Notes

- Each episode's number depends only on that episode, so it stays put as others come and go: the stated number
  (`S18/E07`, ARTE `(3/8)`); later parts and numbers stated twice move to separate high ranges; unnumbered
  episodes get season = broadcast year and a number derived from the broadcast minute. All fit in 32 bits.
- When the API fails, previously loaded results keep being served.
- Catalogs only cover the newest `CATALOG_DEPTH` films per channel; older shows are found through search.
- Not supported: subtitles, ARTE collections without part markers (listed as movies), past live events whose
  video links a live stream.

## Development

```sh
npm install
npm run check   # tsc
npm test
```
