# snokadb-news

Publikt nyhetsflöde och årsarkiv för [SnokaDb](https://snokadb.se).

## Vad som genereras

- `news.json` – samlad lista för SnokaDb-nyhetssidan
- `rss.xml` – senaste ~100 posterna
- `archive/YYYY.json` – årsarkiv (utan `generatedAt`)
- `archive/index.json` – översikt över år
- `data/player-index.json` – lokal fallback för spelarindex

## Källor

RSS/API hämtas från IFK Norrköping, NT, FotbollDirekt, SVT, Sportbladet, SportExpressen, TV4, Sveriges Radio samt poddarna Genom Ljuva Livet, Snokasnack, Studio Peking och Gate Upp och Gate Ner.

Spelarindex hämtas från `https://snokadb.se/data/news-player-index.json` med fallback till `data/player-index.json`.

Tidningsposter kan få `archiveRefs` mot KB/Svenska tidningar (endast metadata, aldrig fulltext).

## Köra lokalt

```bash
npm test
npm run generate
npm run generate   # ska skriva "No news changes" om inget nytt
```

Valfri historik-seed: lägg SnokaDb-filer i `seed/` (gitignored) innan första körningen.

## GitHub Actions

Schemalagd varje timme + `workflow_dispatch`. Commit/push sker bara när genererade filer ändrats.
