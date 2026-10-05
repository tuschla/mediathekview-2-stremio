# Mediathek Stremio-Add-on

[English](README.md) · Deutsch

Stremio-Add-on für die Mediatheken der öffentlich-rechtlichen Sender (Standard: ARD, ZDF, ARTE), live über die
API von [MediathekViewWeb](https://mediathekviewweb.de). Funktioniert mit jedem Client, der das Stremio-Protokoll
spricht.

- Serien nach Thema gruppiert („Tatort“), ARTE-Serien nach Teilangaben „(n/m)“.
- Filme aus Film-Themen („Filme im Ersten“, …) und alle übrigen ARTE-Sendungen.
- Audiodeskription, Gebärdensprache und Sprachfassungen werden zu zusätzlichen Streams desselben Eintrags.
- Bilder von der Senderseite; Suche über alle Sender.

## Starten

```sh
docker run -d -p 127.0.0.1:7000:7000 --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  ghcr.io/tuschla/mediathekview-2-stremio
```

oder `node src/server.ts` (Node.js ≥ 22.18). Manifest: `http://<host>:7000/manifest.json`

Es gibt weder Authentifizierung noch Rate-Limiting, und jede nicht gecachte Anfrage fragt MediathekViewWeb ab.
Den Port nicht öffentlich freigeben oder einen Reverse-Proxy mit Rate-Limiting davorschalten.

## Konfiguration

| Variable | Standard | Bedeutung |
|---|---|---|
| `PORT` / `HOST` | `7000` / `0.0.0.0` | Listen-Adresse |
| `PUBLIC_URL` | `Host` der Anfrage | Basis-URL der Bildlinks; hinter einem Reverse-Proxy setzen |
| `CHANNELS` | `ARD,ZDF,ARTE.DE` | Sendernamen in MediathekView, z. B. `3Sat`, `BR`, `WDR`, `ZDFinfo` |
| `MIN_DURATION` | `300` | Filme unter dieser Länge in Sekunden ignorieren |
| `CATALOG_DEPTH` | `2000` | Neueste Filme pro Sender, aus denen die Kataloge entstehen (max. 10000) |
| `MAX_SHOW_FILMS` | `1000` | Neueste Filme einer Sendung, die als Folgen gelistet werden (max. 10000) |
| `MOVIE_TOPICS` | siehe `src/config.ts` | Regex der Themen (außer ARTE), die Filmsammlungen sind |
| `CACHE_TTL_MINUTES` | `30` | Cache-Dauer der API-Ergebnisse |
| `MAX_CONCURRENT_REQUESTS` | `4` | Parallele Anfragen an MediathekViewWeb |

## Hinweise

- Folgennummern bleiben stabil, auch wenn Folgen hinzukommen oder wegfallen: die angegebene Nummer (`S18/E07`,
  ARTE `(3/8)`), sonst Staffel = Sendejahr und Folge = Minute im Jahr. Alle Nummern passen in 32 Bit.
- Fällt die API aus, werden bereits geladene Ergebnisse weiter ausgeliefert.
- Kataloge umfassen nur die neuesten `CATALOG_DEPTH` Filme pro Sender; ältere Sendungen findet die Suche.
- Nicht unterstützt: Untertitel, ARTE-Reihen ohne Teilangaben (erscheinen als Filme), vergangene Live-Events,
  deren Video auf einen Live-Stream verweist.

## Entwicklung

```sh
npm install
npm run check   # tsc
npm test
```
