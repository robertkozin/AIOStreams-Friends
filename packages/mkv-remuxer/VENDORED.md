# Vendored

Vendored from [FPNDev/mkv-remuxer](https://github.com/FPNDev/mkv-remuxer) at
`bd8ff18` (published to npm as `@rimjoeh/mkv-remuxer`), AGPL-3.0-only.
First vendored at `da07227` (0.1.4).

To see what changed here since, diff `src/` against that commit. The local
changes are:

- Audio policy (`media/codecs.ts`, `hls/playlists.ts`): every audio track is
  served once, in file order, in one audio group. AAC, Opus, FLAC and MP3 are
  copied; everything else is transcoded to AAC. Upstream copies AC-3, E-AC-3,
  DTS and TrueHD, adds per-language AAC fallbacks (`aacFallback`, ignored
  here), and splits audio into one group per codec. The host picks the
  starting track by its place among the file's audio tracks, which needs the
  single group in file order.
- No language filter: upstream drops Russian audio and subtitles.
- Dolby Vision (`matroska/tracks.ts`, `media/track.ts`, `media/codecs.ts`,
  `hls/playlists.ts`, `hls/remux.ts`): profile 5 is served as `dvh1`,
  profile 8 as its base layer with `SUPPLEMENTAL-CODECS`. Matroska sources
  only; MP4 sources keep their sample entry but get no playlist signalling.
- `CACHE_VERSION` in `hls/hls-service.ts` clears rendered media on start when
  renditions or playlists change. `MEDIA_INDEX_VERSION` is one past
  upstream's, for the Dolby Vision field.
