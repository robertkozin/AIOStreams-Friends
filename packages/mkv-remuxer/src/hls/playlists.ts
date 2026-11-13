import {
  aacChannels,
  aacSampleRate,
  bcp47,
  codecString,
  dolbyVisionMode,
  supplementalCodecString,
  type AudioRendition,
  type Rendition,
  type RenditionSet,
  type SubtitleRendition,
} from '../media/codecs.js';
import { hevcTransferCharacteristics } from '../media/hevc.js';
import {
  aacSegmentStart,
  copiedAudioStart,
  segmentCount,
  segmentStart,
  type MediaIndex,
} from '../media/media-index.js';

const AUDIO_GROUP = 'audio';
const SUBTITLE_GROUP = 'subs';
const VIDEO_RANGES: Record<number, string> = { 16: 'PQ', 18: 'HLG' };

const languageNames = new Intl.DisplayNames(['en'], { type: 'language' });

// An AAC rendition is named after its source with the format family, such
// as "DTS-HD MA" or "DD+ Atmos", replaced by "AAC". Atmos is dropped first
// because it can stand apart from the codec, as in "TrueHD 7.1 Atmos".
const ATMOS = /[\s.]*(?<![\p{L}\p{N}])Atmos(?![\p{L}\p{N}])/giu;
const FORMAT_FAMILY =
  /(?<![\p{L}\p{N}])(?:DTS(?:[-:]?(?:HD|X|ES))?(?:[\s.-]+(?:MA|HRA|Master[\s.]Audio|High[\s.-]Res(?:olution)?(?:[\s.]Audio)?|Express))?|(?:Dolby[\s.-]*)?TrueHD|Dolby(?:[\s.-]*Digital(?:[\s.-]*Plus)?)?|DD\+|DDP|DD|E-?AC-?3|AC-?3|L?PCM|MP[123]|Vorbis|ALAC|Apple[\s.-]*Lossless|WavPack|TTA|MLP)(?![\p{L}+])/giu;
const AAC_RUN = /AAC(?:[\s.:-]+AAC)+/gu;
const AAC_BEFORE_DIGIT = /AAC[.\s]*(?=\d)/gu;

export function renditionPath(rendition: Rendition): string {
  switch (rendition.type) {
    case 'video':
      return 'video';
    case 'audio':
      return `${rendition.transcode ? 'aac' : 'audio'}/${rendition.track.number}`;
    case 'subtitle':
      return `subtitles/${rendition.track.number}`;
  }
}

export function segmentFileName(rendition: Rendition, n: number): string {
  return `${n}.${rendition.type === 'subtitle' ? 'vtt' : 'm4s'}`;
}

export function mediaPlaylist(index: MediaIndex, rendition: Rendition): string {
  const count = segmentCount(index);
  const rate =
    rendition.type === 'audio' && rendition.transcode
      ? aacSampleRate(rendition.track)
      : undefined;
  const copied = rendition.type === 'audio' && !rendition.transcode;
  const start = (n: number) => {
    if (copied) {
      return copiedAudioStart(index, rendition.track.number, n);
    }

    return rate === undefined
      ? segmentStart(index, n)
      : aacSegmentStart(index, rate, n) / rate;
  };
  const micros = (seconds: number) => Math.round(seconds * 1e6);
  const durations = Array.from(
    { length: count },
    (_, n) =>
      (micros(n + 1 < count ? start(n + 1) : index.duration) -
        micros(start(n))) /
      1e6,
  );

  // Version 7 is the floor for fragmented MP4 segments and EXT-X-MAP.
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    // Must be an integer and no shorter than the longest segment.
    `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...durations))}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-INDEPENDENT-SEGMENTS',
  ];
  // Subtitle renditions are WebVTT and have no init segment.
  if (rendition.type !== 'subtitle') {
    lines.push('#EXT-X-MAP:URI="init.mp4"');
  }
  for (const [n, duration] of durations.entries()) {
    lines.push(
      `#EXTINF:${duration.toFixed(6)},`,
      segmentFileName(rendition, +n),
    );
  }
  lines.push('#EXT-X-ENDLIST');

  return `${lines.join('\n')}\n`;
}

export function masterPlaylist(
  index: MediaIndex,
  renditions: RenditionSet,
  uriPrefix: string,
): string {
  const uri = (rendition: Rendition) =>
    `${uriPrefix}${renditionPath(rendition)}/index.m3u8`;
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS'];

  // One audio group, in file order, so a host can pick the n-th track: hosts
  // address renditions by their place among the file's audio tracks. At most
  // one member of an audio group may be DEFAULT.
  const defaultAt = Math.max(
    0,
    renditions.audio.findIndex((audio) => audio.track.isDefault),
  );

  const namesMap = new Map<string, number>();
  for (const [at, audio] of renditions.audio.entries()) {
    const channels = audio.transcode
      ? aacChannels(audio.track)
      : (audio.track.channels ?? 2);
    lines.push(
      `#EXT-X-MEDIA:${attributes({
        TYPE: 'AUDIO',
        'GROUP-ID': quoted(AUDIO_GROUP),
        NAME: quoted(uniqueLabel(audio, namesMap)),
        LANGUAGE: optionalQuoted(bcp47(audio.track.language)),
        DEFAULT: at === defaultAt ? 'YES' : 'NO',
        AUTOSELECT: 'YES',
        CHANNELS: quoted(String(channels)),
        URI: quoted(uri(audio)),
      })}`,
    );
  }

  namesMap.clear();

  for (const subtitle of renditions.subtitles) {
    lines.push(
      `#EXT-X-MEDIA:${attributes({
        TYPE: 'SUBTITLES',
        'GROUP-ID': quoted(SUBTITLE_GROUP),
        NAME: quoted(uniqueLabel(subtitle, namesMap)),
        LANGUAGE: optionalQuoted(bcp47(subtitle.track.language)),
        DEFAULT: 'NO',
        AUTOSELECT: 'YES',
        FORCED: subtitle.track.isForced ? 'YES' : 'NO',
        URI: quoted(uri(subtitle)),
      })}`,
    );
  }

  const { track } = renditions.video;
  const videoCodec = codecString(renditions.video);
  const averageBandwidth = Math.round((index.fileLength * 8) / index.duration);
  // The track header's frame duration is a fallback only: some files state a
  // rate their packets do not run at.
  const frameRate =
    index.frameRate ??
    (track.defaultDurationNs ? 1e9 / track.defaultDurationNs : undefined);
  const variant = {
    BANDWIDTH: String(Math.round(averageBandwidth * 1.5)),
    'AVERAGE-BANDWIDTH': String(averageBandwidth),
    SUBTITLES:
      renditions.subtitles.length > 0 ? quoted(SUBTITLE_GROUP) : undefined,
    'CLOSED-CAPTIONS': 'NONE',
    RESOLUTION:
      track.width && track.height
        ? `${track.width}x${track.height}`
        : undefined,
    'FRAME-RATE': frameRate?.toFixed(3),
  };
  // Firefox's MediaCapabilities rejects every av01 codec string paired with
  // a PQ or HLG transfer function, but runs no such check on HEVC strings.
  // Dolby Vision with no other picture is PQ whatever the stream signals.
  const dolbyVision = dolbyVisionMode(renditions.video);
  const videoRange =
    dolbyVision === 'only'
      ? 'PQ'
      : renditions.video.codec === 'hevc'
        ? VIDEO_RANGES[hevcTransferCharacteristics(track)]
        : undefined;
  const supplementalCodecs = supplementalCodecString(renditions.video);

  const pushVariants = (
    audioGroupId: string | undefined,
    codecs: (string | undefined)[],
  ) => {
    const audioVariant = {
      ...variant,
      CODECS: codecs.every(Boolean) ? quoted(codecs.join(',')) : undefined,
      AUDIO: audioGroupId === undefined ? undefined : quoted(audioGroupId),
    };
    lines.push(
      `#EXT-X-STREAM-INF:${attributes({
        ...audioVariant,
        'SUPPLEMENTAL-CODECS': optionalQuoted(supplementalCodecs),
        'VIDEO-RANGE': videoRange,
      })}`,
      uri(renditions.video),
    );
    // Dolby Vision alone has no picture to offer as SDR.
    if (videoRange && dolbyVision !== 'only') {
      lines.push(
        `#EXT-X-STREAM-INF:${attributes({
          ...audioVariant,
          'VIDEO-RANGE': 'SDR',
        })}`,
        `${uri(renditions.video)}?range=sdr`,
      );
    }
  };

  if (renditions.audio.length === 0) {
    pushVariants(undefined, [videoCodec]);
  } else {
    pushVariants(AUDIO_GROUP, [
      videoCodec,
      ...new Set(renditions.audio.map((audio) => codecString(audio))),
    ]);
  }

  return `${lines.join('\n')}\n`;
}

function attributes(values: Record<string, string | undefined>): string {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) {
      pairs.push(`${key}=${value}`);
    }
  }

  return pairs.join(',');
}

// A quoted attribute value may hold neither a double quote nor a line
// break.
function quoted(value: string): string {
  return `"${value.replaceAll(/["\r\n]/gu, "'")}"`;
}

function optionalQuoted(value: string | undefined): string | undefined {
  return value === undefined ? undefined : quoted(value);
}

function uniqueLabel(
  rendition: AudioRendition | SubtitleRendition,
  used: Map<string, number>,
): string {
  const { track } = rendition;
  const language = bcp47(track.language);
  let label = track.name;
  if (!label && language) {
    try {
      label = languageNames.of(language);
    } catch {
      label = undefined;
    }
  }
  label ??= `Unknown`;
  if (rendition.type === 'audio' && rendition.transcode) {
    label = aacName(label);
  }

  const usedTimes = (used.get(label) ?? 0) + 1;
  if (usedTimes > 1) {
    label = `${label} #${usedTimes}`;
  }
  used.set(label, usedTimes);

  return label;
}

// A label with no format token keeps its words and gains " AAC".
function aacName(label: string): string {
  const stripped = label.replace(ATMOS, '');
  const renamed = stripped.replace(FORMAT_FAMILY, 'AAC');
  const name =
    renamed === stripped
      ? `${stripped} AAC`
      : renamed.replace(AAC_RUN, 'AAC').replace(AAC_BEFORE_DIGIT, 'AAC ');

  return name.replaceAll(/\s+/gu, ' ').trim();
}
