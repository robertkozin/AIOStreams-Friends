import type { Request } from 'express';
import {
  buildMediaStreams,
  type ExtraSubtitle,
  isUsenetHlsCandidate,
  type DeviceProfile,
  type JellyfinMediaSource,
  type MediaSourceRecord,
} from '@aiostreams/core';
import { playlistName } from '../api/hls.js';
import { bodyField, qs } from './context.js';

interface ProfileEntry {
  Type?: string;
  Container?: string;
}

const entries = (profile: DeviceProfile | undefined, key: string) =>
  Array.isArray(profile?.[key]) ? (profile[key] as ProfileEntry[]) : undefined;

const listed = (list: string | undefined, value: string) =>
  !list || list.split(',').some((c) => c.trim().toLowerCase() === value);

/**
 * The containers the remuxer reads, by a version's container, with the names
 * a device profile may list each under.
 */
const HLS_CONTAINERS: Record<string, string[]> = {
  mkv: ['mkv', 'matroska'],
  webm: ['webm'],
  mp4: ['mp4'],
  m4v: ['m4v', 'mp4'],
  mov: ['mov'],
};

/** False only for a profile that lists what it direct plays, without these. */
function directPlays(
  profile: DeviceProfile | undefined,
  names: string[]
): boolean {
  const direct = entries(profile, 'DirectPlayProfiles');
  if (!direct) return true;
  return direct.some(
    (p) =>
      (!p.Type || p.Type === 'Video') &&
      names.some((name) => listed(p.Container, name))
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
 * Gives a native usenet MKV, WebM, MP4 or MOV version the HLS remux as its
 * transcoding URL, and a client whose profile can't direct play the container
 * is sent to it. Every audio track is in the playlist; the one the client
 * picked (or the version's default, where its tracks are known) is the one it
 * starts with.
 */
export function offerHls(
  source: JellyfinMediaSource,
  record: MediaSourceRecord,
  req: Request,
  opts: {
    itemId: string;
    playSessionId: string;
    token?: string;
    profile?: DeviceProfile;
  }
): void {
  if (record.live || record.notice) return;
  const names = HLS_CONTAINERS[record.container];
  if (!names || !isUsenetHlsCandidate(record.url)) return;
  const query = new URLSearchParams({
    MediaSourceId: record.msid,
    PlaySessionId: opts.playSessionId,
  });
  // Rows read off the name, not the file, say nothing of its tracks; the
  // playlist then starts with the file's own default.
  const asked = Number(
    qs(req, 'AudioStreamIndex') ?? bodyField(req, 'AudioStreamIndex')
  );
  const audio =
    (Number.isInteger(asked) && asked >= 0 ? asked : undefined) ??
    (record.parsedFile?.audioTracks?.length
      ? (source.DefaultAudioStreamIndex as number | undefined)
      : undefined);
  if (audio !== undefined) query.set('AudioStreamIndex', String(audio));
  if (opts.token) query.set('api_key', opts.token);
  source.SupportsTranscoding = true;
  // Named for the file, which players that title a stream by its address show.
  source.TranscodingUrl = `/videos/${opts.itemId}/${playlistName(record.filename)}?${query}`;
  source.TranscodingSubProtocol = 'hls';
  source.TranscodingContainer = 'mp4';
  if (!directPlays(opts.profile, names)) source.SupportsDirectPlay = false;
}

/**
 * Only the MediaSourceFields a client asked for, applied after `offerHls`,
 * which reads the full version and adds its own fields.
 */
export function onlyFields<T extends object>(
  source: T,
  fields?: ReadonlySet<string>
): T {
  if (!fields) return source;
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => fields.has(key.toLowerCase()))
  ) as T;
}

/**
 * The version's external subtitles as HLS renditions, each a playlist of its
 * WebVTT file on the subtitle route, at `base`, the mount's address. The
 * client's token rides in their query, as for its subtitles anywhere.
 */
export function externalHlsSubtitles(
  record: MediaSourceRecord,
  opts: {
    itemId: string;
    playSessionId: string;
    token?: string;
    base: string;
    subtitleUrl: (index: number, format: string) => string;
  }
): ExtraSubtitle[] {
  return buildMediaStreams(record, {
    subtitleFormat: () => 'vtt',
    subtitleUrl: opts.subtitleUrl,
    subtitleToken: opts.token,
    playSessionId: opts.playSessionId,
  })
    .filter((s) => s.Type === 'Subtitle' && s.IsExternal && s.DeliveryUrl)
    .map((s) => ({
      name: String(s.DisplayTitle ?? s.Language ?? 'Subtitle'),
      language: s.Language ? String(s.Language) : undefined,
      forced: s.IsForced === true,
      uri: `${opts.base}${String(s.DeliveryUrl).replace(
        '/0/Stream.vtt',
        '/subtitles.m3u8'
      )}`,
    }));
}
