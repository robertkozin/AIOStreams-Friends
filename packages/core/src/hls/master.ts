/**
 * The master playlist with its `audio`th audio rendition, in playlist order,
 * as the one players start with. Every other audio rendition stops being a
 * default, as HLS allows one per group.
 */
export function withDefaultAudio(master: string, audio: number): string {
  let n = -1;
  return master
    .split('\n')
    .map((line) => {
      if (!line.startsWith('#EXT-X-MEDIA:') || !line.includes('TYPE=AUDIO'))
        return line;
      n++;
      return line.replace(
        /DEFAULT=(YES|NO)/,
        `DEFAULT=${n === audio ? 'YES' : 'NO'}`
      );
    })
    .join('\n');
}

/** A subtitle served beside the file, as an HLS rendition of its own. */
export interface ExtraSubtitle {
  name: string;
  language?: string;
  forced?: boolean;
  /** Its media playlist. */
  uri: string;
}

const quote = (value: string) => `"${value.replace(/["\r\n]/g, "'")}"`;

/**
 * The master playlist served from another address: its relative URIs made
 * absolute against `base`, where the remux lives, and `subtitles` added to
 * its subtitle group (made, and named by every variant, where it has none).
 */
export function withExtraSubtitles(
  master: string,
  base: string,
  subtitles: ExtraSubtitle[]
): string {
  const absolute = (uri: string) => new URL(uri, base).toString();
  const lines = master
    .split('\n')
    .map((line) =>
      !line || line.startsWith('#')
        ? line.replace(/URI="([^"]*)"/, (_m, uri) => `URI="${absolute(uri)}"`)
        : absolute(line)
    );
  if (!subtitles.length) return lines.join('\n');
  const existing = lines
    .find((l) => l.startsWith('#EXT-X-MEDIA:') && l.includes('TYPE=SUBTITLES'))
    ?.match(/GROUP-ID="([^"]*)"/)?.[1];
  const group = existing ?? 'subs';
  const added = subtitles.map((s) =>
    [
      '#EXT-X-MEDIA:TYPE=SUBTITLES',
      `GROUP-ID=${quote(group)}`,
      `NAME=${quote(s.name)}`,
      ...(s.language ? [`LANGUAGE=${quote(s.language)}`] : []),
      'DEFAULT=NO',
      'AUTOSELECT=NO',
      `FORCED=${s.forced ? 'YES' : 'NO'}`,
      `URI=${quote(s.uri)}`,
    ].join(',')
  );
  const at = lines.findIndex((l) => l.startsWith('#EXT-X-STREAM-INF:'));
  const out = lines.map((line) =>
    existing || !line.startsWith('#EXT-X-STREAM-INF:')
      ? line
      : `${line},SUBTITLES=${quote(group)}`
  );
  out.splice(at < 0 ? out.length : at, 0, ...added);
  return out.join('\n');
}

/** One WebVTT file as a media playlist of a single segment. */
export function subtitlePlaylist(uri: string, durationS: number): string {
  const duration = Math.max(1, durationS);
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${Math.ceil(duration)}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    `#EXTINF:${duration.toFixed(3)},`,
    uri,
    '#EXT-X-ENDLIST',
    '',
  ].join('\n');
}
