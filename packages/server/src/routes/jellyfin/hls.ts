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
 * default, where its tracks are known) is the one it starts with.
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
  if (record.container !== 'mkv' || !isUsenetHlsCandidate(record.url)) return;
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
  if (!directPlaysMkv(opts.profile)) source.SupportsDirectPlay = false;
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
