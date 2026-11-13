import path from 'node:path';

// Numbered segments, the only evictable files. Playlists and init segments are
// excluded so eviction never breaks a rendition's entry points.
const SEGMENT_FILE = /^\d+\.(m4s|vtt)$/u;

export function isSegmentFile(name: string): boolean {
  return SEGMENT_FILE.test(name);
}

/** Every path under the cache directory. Nothing else joins cache paths. */
export function createCacheLayout(root: string) {
  const hlsDir = path.join(root, 'hls');

  // Its mtime records when the source was last asked for, across restarts.
  const usedMarker = (sourceId: string): string => {
    return path.join(hlsDir, sourceId, '.used');
  };

  // Records which CACHE_VERSION wrote the media under hlsDir.
  const versionFile = (): string => {
    return path.join(root, 'version');
  };

  const interleavingFile = (): string => {
    return path.join(root, 'interleaving.json');
  };

  const mediaDir = (sourceId: string, fileId: string): string => {
    return path.join(hlsDir, sourceId, fileId);
  };

  const indexFile = (sourceId: string, fileId: string): string => {
    return path.join(mediaDir(sourceId, fileId), 'index.json');
  };

  // The sample tables of an MP4 file, one per track.
  const sampleDir = (sourceId: string, fileId: string): string => {
    return path.join(mediaDir(sourceId, fileId), 'samples');
  };

  const masterFile = (sourceId: string, fileId: string): string => {
    return path.join(mediaDir(sourceId, fileId), 'master.m3u8');
  };

  // relative is a playlist URI, so its separator is always a forward slash.
  const mediaFile = (
    sourceId: string,
    fileId: string,
    relative: string,
  ): string => {
    return path.join(mediaDir(sourceId, fileId), ...relative.split('/'));
  };

  return {
    root,
    hlsDir,
    versionFile,
    usedMarker,
    interleavingFile,
    mediaDir,
    indexFile,
    sampleDir,
    masterFile,
    mediaFile,
  };
}

export type CacheLayout = ReturnType<typeof createCacheLayout>;
