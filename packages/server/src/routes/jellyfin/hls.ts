import {
  buildMediaStreams,
  isUsenetHlsCandidate,
  type DeviceProfile,
  type JellyfinMediaSource,
  type MediaSourceRecord,
} from '@aiostreams/core';

interface ProfileEntry {
  Type?: string;
  Container?: string;
}

const entries = (profile: DeviceProfile | undefined, key: string) =>
  Array.isArray(profile?.[key]) ? (profile[key] as ProfileEntry[]) : undefined;

const listed = (list: string | undefined, value: string) =>
  !list || list.split(',').some((c) => c.trim().toLowerCase() === value);

/** False only for a profile that lists what it direct plays, without MKV. */
function directPlaysMkv(profile: DeviceProfile | undefined): boolean {
  const direct = entries(profile, 'DirectPlayProfiles');
  if (!direct) return true;
  return direct.some(
    (p) =>
      (!p.Type || p.Type === 'Video') &&
      (listed(p.Container, 'mkv') || listed(p.Container, 'matroska'))
  );
}

/**
 * Where Jellyfin's audio track sits among the version's audio tracks, which
 * is how the remuxer orders its audio renditions: both follow the file.
 */
export function hlsAudioPlace(
  record: MediaSourceRecord,
  audioStreamIndex: number
): number | undefined {
  const audio = buildMediaStreams(record, {
    subtitleFormat: () => 'srt',
    subtitleUrl: () => '',
  }).filter((s) => s.Type === 'Audio');
  const at = audio.findIndex((s) => s.Index === audioStreamIndex);
  return at >= 0 ? at : undefined;
}

/**
 * Gives a native usenet MKV version the HLS remux as its transcoding URL, and
 * a client whose profile can't direct play MKV is sent to it. Every audio
 * track is in the playlist; the one the client picked (or the version's
 * default) is the one it starts with.
 */
export function offerHls(
  source: JellyfinMediaSource,
  record: MediaSourceRecord,
  opts: {
    itemId: string;
    playSessionId: string;
    token?: string;
    profile?: DeviceProfile;
    audioStreamIndex?: number;
  }
): void {
  if (record.live || record.notice) return;
  if (record.container !== 'mkv' || !isUsenetHlsCandidate(record.url)) return;
  const query = new URLSearchParams({
    MediaSourceId: record.msid,
    PlaySessionId: opts.playSessionId,
  });
  const audio =
    opts.audioStreamIndex ??
    (source.DefaultAudioStreamIndex as number | undefined);
  if (audio !== undefined) query.set('AudioStreamIndex', String(audio));
  if (opts.token) query.set('api_key', opts.token);
  source.SupportsTranscoding = true;
  source.TranscodingUrl = `/videos/${opts.itemId}/master.m3u8?${query}`;
  source.TranscodingSubProtocol = 'hls';
  source.TranscodingContainer = 'mp4';
  if (!directPlaysMkv(opts.profile)) source.SupportsDirectPlay = false;
}
