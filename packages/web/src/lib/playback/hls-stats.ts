/* eslint-disable lingui/no-unlocalized-strings -- debug statistics, English only, to keep the locale files untouched */
import Hls from 'hls.js';

export const STATS_PAGES = [{ id: 'playback', label: 'Playback' }];

/** Which player the page's video plays through, and why that one. */
export type VideoMode =
  | { kind: 'file' }
  | { kind: 'native' }
  | { kind: 'hlsjs'; why: 'no native HLS' | 'native failed' | 'subtitle' };

/** The last segment hls.js fetched for the picture. */
export interface FragmentLoad {
  sn: number;
  bytes: number;
  ms: number;
  durationS: number;
}

export interface VideoStatsInput {
  video: HTMLVideoElement;
  mode: VideoMode;
  hls: Hls | null;
  /** Times the stream was reopened where it was, for a track or a failure. */
  reopens: number;
  lastFragment?: FragmentLoad;
  /** The playlist's default audio, which native HLS was opened with. */
  nativeAudio?: string;
}

const READY_STATES = [
  'nothing',
  'metadata',
  'current data',
  'future data',
  'enough data',
];
const NETWORK_STATES = ['empty', 'idle', 'loading', 'no source'];

const seconds = (s: number) => `${s.toFixed(1)} s`;
const kbps = (bps: number) =>
  bps >= 1e6
    ? `${(bps / 1e6).toFixed(1)} Mb/s`
    : `${Math.round(bps / 1e3)} kb/s`;
const megabytes = (bytes: number) => `${(bytes / 1e6).toFixed(2)} MB`;

function playerLine({ mode, hls }: VideoStatsInput): string {
  switch (mode.kind) {
    case 'file':
      return "File, in the browser's own player";
    case 'native':
      return "HLS, in the browser's own player";
    case 'hlsjs': {
      // hls.js prefers Managed Media Source (Safari 17+) where there is one.
      const source =
        'ManagedMediaSource' in window &&
        hls?.config.preferManagedMediaSource !== false
          ? 'Managed Media Source'
          : 'Media Source';
      return `HLS, in hls.js ${Hls.version} over ${source}`;
    }
  }
}

const HLSJS_REASONS = {
  'no native HLS': 'the browser has no HLS of its own',
  'native failed': "the browser's own HLS failed",
  subtitle: "a subtitle the browser's own HLS can't show",
};

/** Seconds buffered from the play position on, in the range holding it. */
function bufferedAhead(video: HTMLVideoElement): number {
  const at = video.currentTime;
  for (let i = 0; i < video.buffered.length; i++) {
    if (video.buffered.start(i) <= at + 0.1 && video.buffered.end(i) >= at)
      return video.buffered.end(i) - at;
  }
  return 0;
}

export function videoStatsText(input: VideoStatsInput): string {
  const { video, hls, mode } = input;
  const lines: [string, string][] = [['Player', playerLine(input)]];
  if (mode.kind === 'hlsjs')
    lines.push(['Player reason', HLSJS_REASONS[mode.why]]);
  if (input.reopens) lines.push(['Reopened', String(input.reopens)]);

  if (video.videoWidth)
    lines.push(['Picture', `${video.videoWidth}×${video.videoHeight}`]);
  const level = hls && hls.levels[hls.currentLevel];
  if (level) {
    const codecs = [level.videoCodec, level.audioCodec].filter(Boolean);
    if (codecs.length) lines.push(['Codecs', codecs.join(', ')]);
    if (level.bitrate) lines.push(['Bitrate', kbps(level.bitrate)]);
  }
  if (hls) {
    const audio = hls.audioTracks[hls.audioTrack];
    if (audio) lines.push(['Audio', audio.name || audio.lang || '—']);
    const subtitle = hls.subtitleTracks[hls.subtitleTrack];
    lines.push([
      'Subtitle',
      subtitle ? subtitle.name : 'none from the playlist',
    ]);
  } else if (mode.kind === 'native' && input.nativeAudio !== undefined) {
    lines.push([
      'Audio',
      `${input.nativeAudio || '—'}, the playlist's default (switched by reopening)`,
    ]);
  }

  const quality = video.getVideoPlaybackQuality?.();
  if (quality) {
    const total = quality.totalVideoFrames;
    const dropped = quality.droppedVideoFrames;
    const share = total ? ` (${((dropped / total) * 100).toFixed(1)}%)` : '';
    lines.push(['Frames', `${dropped} dropped of ${total}${share}`]);
  }
  lines.push(['Buffered ahead', seconds(bufferedAhead(video))]);
  lines.push([
    'Position',
    `${seconds(video.currentTime)} of ${seconds(video.duration || 0)}, ${video.playbackRate}×`,
  ]);

  if (hls) {
    if (hls.bandwidthEstimate)
      lines.push(['Bandwidth', kbps(hls.bandwidthEstimate)]);
    const f = input.lastFragment;
    if (f)
      lines.push([
        'Last segment',
        `#${f.sn}, ${megabytes(f.bytes)} for ${seconds(f.durationS)} in ${f.ms} ms` +
          (f.ms ? `, ${kbps((f.bytes * 8 * 1000) / f.ms)}` : ''),
      ]);
  } else {
    lines.push([
      'State',
      `${READY_STATES[video.readyState] ?? video.readyState}, network ${NETWORK_STATES[video.networkState] ?? video.networkState}`,
    ]);
  }
  if (video.error)
    lines.push(['Error', `${video.error.code} ${video.error.message}`]);

  return lines.map(([key, value]) => `${key}: ${value}`).join('\n');
}
