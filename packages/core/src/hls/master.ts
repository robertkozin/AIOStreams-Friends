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
