# AIOStreams-Friends

A small personal fork of [AIOStreams](https://github.com/Viren070/AIOStreams). My goal is to share my configuration with my friends and make watching movies and tv easy for them. Most of the changes are focused on QoL for casual users.

For everything about AIOStreams itself (features, setup, configuration), see the [original README](https://github.com/Viren070/AIOStreams#readme).

## Changes from upstream

### Playback

- **HLS streaming.** Usenet MKVs are remuxed to HLS on the fly, so they play in any browser or TV without a native app.

### Jellyfin and the web app

- **Jellyfin API with no prefix.** With `JELLYFIN_ROOT_CONFIGURATION` the Jellyfin server is mounted on the root path.
- **A simpler home page.** Shows continue watching, next up and upcoming instead of catalog rows.
- **Hisense TVs.** The web app runs on Hisense VIDAA TVs and projectors, remote included.
- **Personalized icons.**
- **Casting and picture in picture.** The web player can now cast and use PiP.

### Streams

- **Friendlier formatter.** A `friendly` modifier turns tags into plain English (`BluRay REMUX` reads as "Blu-ray (exact copy)"), and `stream.warnings` flags things worth knowing before you pick a stream: a cinema recording, burned-in subtitles, Dolby Vision without HDR fallback, an upscale, 3D or AV1.

### Fixes

- Streams whose language is inferred from metadata now get the `Original` tag when it's the title's original language.
- Watch parties started from a hidden persona are listed like everyone else's.
