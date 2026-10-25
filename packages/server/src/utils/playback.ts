import { parsePlaybackUrl } from '@aiostreams/core';
import type { PlaybackParams } from '../routes/api/debrid.js';

/** The parts of an owned playback link, the same as the playback route's. */
export function playbackParamsOf(url: string): PlaybackParams | undefined {
  const target = parsePlaybackUrl(url);
  if (!target) return undefined;
  const fallbackKey = url
    .slice(url.indexOf(target.encryptedStoreAuth))
    .split('/')[1];
  return {
    encryptedStoreAuth: target.encryptedStoreAuth,
    fallbackKey,
    fileInfo: target.fileInfoRaw,
    metadataId: target.metadataId,
    filename: target.filename,
  };
}

/**
 * An error video as HLS, for a player that asked for HLS. Each is cut beside
 * its MP4 once, as `static/hls/<name>/`, with
 * `ffmpeg -i <name>.mp4 -c copy -f hls -hls_time 120 -hls_playlist_type vod
 * -hls_segment_type fmp4 -hls_fmp4_init_filename init.mp4
 * -hls_segment_filename 'hls/<name>/%d.m4s' hls/<name>/index.m3u8`.
 */
export function staticHlsPath(file: string): string {
  return `/static/hls/${file.replace(/\.mp4$/, '')}/index.m3u8`;
}
