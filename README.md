# loft-twitch

Live Twitch lists for THE LOFT (VRChat) media tablet.

* `worker/` — Cloudflare Worker `loft-twitch` (https://loft-twitch.theloft.workers.dev), cron every 5 min.
  Polls Twitch Helix (needs `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET` secrets; mock data until then), applies the
  PG filter, keeps sticky slots (`/s/0..299` -> 302 to `https://www.twitch.tv/<login>`, kept while live + 2 h),
  search `/q?=<words>`, popularity `/baked?n=500`, snapshot `/export`.
* `.github/workflows/publish.yml` — every ~5 min builds `l/*.json` (each < 7000 bytes) and `a/*.jpg` thumbnail atlases
  (960x864, 5x8 cells of 192x108) and deploys them to https://the-loft-vr.github.io/loft-twitch/ (trusted by VRChat for
  strings and images). Built-in `GITHUB_TOKEN` only.
* `baked.json` — channels whose `https://www.twitch.tv/<login>` URL is baked into the world (trusted video host).
  Placeholder until `tools/pick_baked.py` runs with real data.
* `tools/charset.txt` — every character the world's fonts can draw (titles are reduced to it).

PG filter: categories Pools/Hot Tubs/Beaches, ASMR, Slots, Casino, Virtual Casino, Poker, Gambling, Sports Betting,
Blackjack, Roulette, Stake, Crypto are never shown; streams flagged `is_mature` or carrying any of the content labels
SexualThemes, DrugsIntoxication, Gambling, ProfanityVulgarity, ViolentGraphic, MatureGame are hidden (override the label
list with the `EXCLUDE_LABELS` Worker variable). Streams whose labels have not been read yet are hidden too.
