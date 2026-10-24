import {
  hlsEnabled,
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
 * Gives a native usenet MKV version the HLS remux as its transcoding URL, and
 * a client whose profile can't direct play MKV is sent to it. Every audio
 * track is in the playlist, so the client switches among them itself.
 */
export function offerHls(
  source: JellyfinMediaSource,
  record: MediaSourceRecord,
  opts: {
    itemId: string;
    playSessionId: string;
    token?: string;
    profile?: DeviceProfile;
  }
): void {
  if (!hlsEnabled() || record.live || record.notice) return;
  if (record.container !== 'mkv' || !isUsenetHlsCandidate(record.url)) return;
  const query = new URLSearchParams({
    MediaSourceId: record.msid,
    PlaySessionId: opts.playSessionId,
  });
  if (opts.token) query.set('api_key', opts.token);
  source.SupportsTranscoding = true;
  source.TranscodingUrl = `/videos/${opts.itemId}/master.m3u8?${query}`;
  source.TranscodingSubProtocol = 'hls';
  source.TranscodingContainer = 'mp4';
  if (!directPlaysMkv(opts.profile)) source.SupportsDirectPlay = false;
}
