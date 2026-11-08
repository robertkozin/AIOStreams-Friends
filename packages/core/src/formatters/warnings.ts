import type { ParsedStream } from '../db/schemas.js';
import { formatDurationPattern } from './utils.js';

const CINEMA_QUALITIES = new Set(['CAM', 'TS', 'TC', 'SCR']);
const THREE_D_TAGS = new Set(['3D', 'H-OU', 'H-SBS']);
const OLD_ENCODES = new Set(['XviD', 'DivX', 'MPEG-4']);
// Below this share of the expected runtime a file is likely a sample, a
// truncated post or the wrong episode. Listed runtimes can run well over the
// real one (an hour-long network show is ~43 minutes without ads), so the
// margin is wide.
const SHORT_RUNTIME_RATIO = 0.5;
// audio many TVs and every browser cannot decode
const LIMITED_AUDIO = new Set([
  'DTS',
  'DTS-ES',
  'DTS-HD',
  'DTS-HD MA',
  'DTS:X',
  'TrueHD',
]);

/**
 * Short warnings for anything likely to cause a bad viewing experience, each
 * as `<tag>: <what it means>`. `expectedMinutes` is the episode's or
 * title's listed runtime.
 */
export function streamWarnings(
  stream: ParsedStream,
  expectedMinutes?: number
): string[] {
  const file = stream.parsedFile;
  const visual = file?.visualTags ?? [];
  // Atmos rides on DD+ or TrueHD, so it says nothing about compatibility
  const audio = (file?.audioTags ?? []).filter((tag) => tag !== 'Atmos');
  const warnings: string[] = [];

  if (file?.quality && CINEMA_QUALITIES.has(file.quality)) {
    warnings.push(
      `${file.quality}: Recorded in a cinema, poor picture and sound`
    );
  }
  if (file?.quality === 'HC HD-Rip') {
    warnings.push('HC: Subtitles burned into the picture');
  }
  const dolbyVision = visual.find((tag) => tag.startsWith('DV'));
  if (dolbyVision && !visual.some((tag) => tag.startsWith('HDR'))) {
    warnings.push(
      `${dolbyVision}: No HDR fallback, colours may look wrong without Dolby Vision`
    );
  }
  if (visual.includes('AI')) {
    warnings.push('AI: Upscaled, not true resolution');
  } else if (file?.upscaled || visual.includes('Upscaled')) {
    warnings.push('Upscaled: Not true resolution');
  }
  const threeD = visual.find((tag) => THREE_D_TAGS.has(tag));
  if (threeD) {
    warnings.push(`${threeD}: Needs a 3D display`);
  }
  if (file?.encode === 'AV1') {
    warnings.push('AV1: Older devices may not play it');
  }
  if (file?.encode && OLD_ENCODES.has(file.encode)) {
    warnings.push(`${file.encode}: Old video format, low quality`);
  }
  if (audio.length > 0 && audio.every((tag) => LIMITED_AUDIO.has(tag))) {
    warnings.push(`${audio.join(' ')}: Some TVs and browsers have no sound`);
  }
  const isIso = (value?: string) =>
    value?.toLowerCase().replace(/^\./, '') === 'iso';
  if (isIso(file?.extension) || isIso(file?.container)) {
    warnings.push('ISO: Disc image, may not play');
  }
  if (
    stream.duration &&
    expectedMinutes &&
    stream.duration < expectedMinutes * 60_000 * SHORT_RUNTIME_RATIO
  ) {
    const length = (ms: number) => formatDurationPattern(ms, '[%-Hh ]%-Mm');
    warnings.push(
      `Duration: Only ${length(stream.duration)} of ${length(expectedMinutes * 60_000)}, may be a sample or incomplete`
    );
  }
  if (stream.service?.cached === false) {
    warnings.push('Uncached: Has to download before playing');
  }
  if (
    (stream.type === 'p2p' || stream.service?.cached === false) &&
    stream.torrent?.seeders === 0
  ) {
    warnings.push('0 Seeders: May never start');
  }

  return warnings;
}
