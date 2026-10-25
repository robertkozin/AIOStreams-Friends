import { t } from '@lingui/core/macro';
import Hls, { ErrorDetails, ErrorTypes, Events } from 'hls.js';
import type React from 'react';
import { checkSubtitleFile, readSubtitleFile } from '../subtitles/files';
import { subtitleLine } from '../subtitles/style';
import {
  castSdkPossible,
  castSessionActive,
  followCast,
  promptCast,
  watchCastDevices,
  type CastMedia,
  type Casting,
} from './cast';
import { ownTrackLabel } from './controller';
import type {
  EngineFactory,
  EngineFile,
  EngineState,
  EngineTrack,
} from './engine';
import { isFullscreen, toggleDocumentFullscreen } from './fullscreen';
import {
  STATS_PAGES,
  videoStatsText,
  type FragmentLoad,
  type VideoMode,
} from './hls-stats';

const STATS_MS = 1000;

const SUBTITLE_TYPES = ['srt', 'vtt', 'ass', 'ssa'];

interface AudioTrack {
  enabled: boolean;
  label: string;
  language: string;
}

interface AudioTrackList extends EventTarget {
  readonly length: number;
  [index: number]: AudioTrack;
}

const audioTracksOf = (video: HTMLVideoElement) =>
  (video as { audioTracks?: AudioTrackList }).audioTracks;

const listed = (list: AudioTrackList) =>
  Array.from({ length: list.length }, (_, i) => list[i]);

interface FileTrack {
  id: string;
  label: string;
  track: TextTrack;
  text: string;
}

/** Ids of the HLS playlist's own subtitle renditions, by their place in it. */
const HLS_SUBTITLE = 'hls-subtitle:';
/** The same, as the browser's own HLS lists them. */
const NATIVE_SUBTITLE = 'native-subtitle:';

/** Safari's, which predates the standard picture in picture. */
type WebKitVideo = HTMLVideoElement & {
  webkitSupportsPresentationMode?(mode: string): boolean;
  webkitSetPresentationMode?(mode: string): void;
  webkitPresentationMode?: string;
};

/** Which player an HLS address opens in: the browser's own where it can, or one of the two. */
type Choice = 'auto' | 'native' | 'hlsjs';

const pipSupported = () =>
  document.pictureInPictureEnabled ||
  'webkitSupportsPresentationMode' in HTMLVideoElement.prototype;

/**
 * The browser plays HLS itself: Safari, recent Chrome, Firefox on Android.
 * Its own player is lighter than hls.js, and the one casting and AirPlay take.
 */
const playsHlsNatively = (el: HTMLVideoElement) =>
  !!el.canPlayType('application/vnd.apple.mpegurl');

/**
 * Native HLS that switches the playlist's audio and subtitles itself, which
 * goes with the audio track API: Safari's. Its tracks arrive a moment after
 * the stream opens, so this is known up front rather than read off them.
 */
const nativeSwitchesTracks = () => 'audioTracks' in HTMLMediaElement.prototype;

const isHls = (url: string) =>
  new URL(url, location.href).pathname.toLowerCase().endsWith('.m3u8');

/** What a cast device is told it plays, by the version's container. */
const CONTAINER_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
};

/** Video events the page ignores while a cast device plays instead. */
const LOCAL_ONLY_EVENTS = new Set([
  'playing',
  'pause',
  'play',
  'waiting',
  'canplay',
  'timeupdate',
  'progress',
  'volumechange',
  'ratechange',
  'ended',
  'error',
]);

/**
 * The browser's own Remote Playback (AirPlay, or casting where the Cast SDK
 * isn't), watched again whenever the video's address changes. A browser that
 * can't keep watching still casts, so the button shows and its picker looks.
 */
function watchRemotePlayback(
  el: HTMLVideoElement | null,
  available: (yes: boolean) => void
): () => void {
  const remote = el?.remote;
  if (!el || !remote) {
    available(false);
    return () => {};
  }
  let id: number | undefined;
  let stopped = false;
  const cancel = () => {
    if (id !== undefined)
      void remote.cancelWatchAvailability(id).catch(() => {});
    id = undefined;
  };
  const watch = () => {
    cancel();
    remote
      .watchAvailability(available)
      .then((n) => {
        if (stopped) void remote.cancelWatchAvailability(n).catch(() => {});
        else id = n;
      })
      .catch((err: unknown) =>
        available((err as Error | undefined)?.name === 'NotSupportedError')
      );
  };
  watch();
  el.addEventListener('loadstart', watch);
  return () => {
    stopped = true;
    el.removeEventListener('loadstart', watch);
    cancel();
  };
}

/** Times a stream that fails is asked for again, which moves past a dead release. */
const MAX_REREADS = 2;

/** One audio or subtitle rendition of a master playlist. */
interface Rendition {
  name: string;
  lang?: string;
  default: boolean;
  forced: boolean;
}

/**
 * A master playlist as read, at the address its redirects led to: the
 * server's remux of one release, or an error video.
 */
interface Playlist {
  /** The address it was asked for, before any redirect. */
  asked: string;
  url: string;
  audio: Rendition[];
  subtitles: Rendition[];
}

function attribute(line: string, key: string): string | undefined {
  const match = new RegExp(`(?:[:,])${key}=("([^"]*)"|[^,]*)`).exec(line);
  return match ? (match[2] ?? match[1]) : undefined;
}

function readPlaylist(url: string, text: string): Playlist {
  const audio: Rendition[] = [];
  const subtitles: Rendition[] = [];
  // A master with several audio groups (one per bitrate, say) lists the same
  // tracks in each; the first is enough.
  let audioGroup: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('#EXT-X-MEDIA:')) continue;
    const type = attribute(line, 'TYPE');
    if (type === 'AUDIO') {
      audioGroup ??= attribute(line, 'GROUP-ID');
      if (attribute(line, 'GROUP-ID') !== audioGroup) continue;
    }
    const list =
      type === 'AUDIO' ? audio : type === 'SUBTITLES' ? subtitles : null;
    list?.push({
      name: attribute(line, 'NAME') ?? '',
      lang: attribute(line, 'LANGUAGE'),
      default: attribute(line, 'DEFAULT') === 'YES',
      forced: attribute(line, 'FORCED') === 'YES',
    });
  }
  return { asked: url, url, audio, subtitles };
}

/**
 * Reads an HLS address before a player opens it. Null when it leads to no
 * playlist, as for a version that failed over to one with no HLS stream. One
 * this page may not read, such as another site's, is left to the player.
 */
async function fetchPlaylist(
  url: string,
  signal: AbortSignal
): Promise<Playlist | null> {
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (err) {
    if (signal.aborted) throw err;
    return { asked: url, url, audio: [], subtitles: [] };
  }
  if (!res.ok) return null;
  const text = await res.text();
  return text.startsWith('#EXTM3U')
    ? { ...readPlaylist(res.url || url, text), asked: url }
    : null;
}

/** The server's remux with its `audio`th rendition as the default. */
const withAudio = (url: string, audio: number) => {
  const next = new URL(url, location.href);
  next.searchParams.set('audio', String(audio));
  return next.toString();
};

/**
 * The page's own `<video>`, for a file or for the server's HLS remux of it
 * (`hlsUrl`). The server's subtitles are `<track>`s, and files the user adds
 * are text tracks after them. An HLS address is read first,
 * for its tracks and to find it leads somewhere, then plays in the browser's
 * own HLS where it has one, and in hls.js where it doesn't, where it fails,
 * or while a subtitle is picked that it can't show (Chrome and Firefox show
 * none of the playlist's). A stream that fails is asked for again, which
 * moves past a release that died, then gives way to the version's file.
 * Without `hlsUrl` it plays the file.
 */
export function hlsEngine(
  video: React.RefObject<HTMLVideoElement | null>
): EngineFactory {
  return (emit) => {
    let file: EngineFile | null = null;
    // The version's own file, for an HLS address that leads nowhere playable.
    let fallbackUrl: string | undefined;
    let hls: Hls | null = null;
    let mode: 'file' | 'native' | 'hlsjs' = 'file';
    // The HLS address this file was asked for, before any redirect.
    let origin: string | null = null;
    let playlist: Playlist | null = null;
    let rereads = 0;
    // The language of the audio playing when the stream was asked for
    // again, kept where the new playlist has it.
    let keepAudio: string | undefined;
    // Paused by the viewer, as a video that failed also reads paused.
    let held = false;
    // Picked in native HLS, for hls.js to apply once it lists its tracks.
    let pendingSubtitle: number | undefined;
    let subtitleId: string | null = null;
    // Whether this file has played; until then its video is paused only
    // because autoplay hasn't begun.
    let begun = false;
    // Whether this file's tracks were announced; a reopen keeps the picks.
    let announced = false;
    // For the statistics: why hls.js plays, how often the stream reopened,
    // and the last picture segment hls.js fetched.
    let hlsWhy: Extract<VideoMode, { kind: 'hlsjs' }>['why'] = 'no native HLS';
    let reopens = 0;
    let lastFragment: FragmentLoad | undefined;
    let statsTimer = 0;
    let elements: HTMLTrackElement[] = [];
    let files: FileTrack[] = [];
    let delayMs = 0;
    let line = subtitleLine();
    let detach = () => {};
    let unattach = () => {};
    // The cast device playing in place of the video, while there is one.
    let casting: Casting | null = null;
    let unfollowCast: (() => void) | null = null;
    // The tracks last listed, which casting matches on the device by name.
    let listedTracks: EngineTrack[] = [];
    // Cues load late, and an HLS track's a segment at a time, so each cue
    // remembers the shift it has.
    const shifted = new WeakMap<TextTrackCue, number>();
    // Browsers disagree on where a cue the file leaves unplaced goes.
    const placed = new WeakSet<VTTCue>();
    // hls.js's subtitle tracks, which stay on the video once it's gone.
    const stale = new WeakSet<TextTrack>();

    // The server's `<track>`s, the user's files, and hls.js's own tracks.
    const textTracks = () =>
      video.current
        ? Array.from(video.current.textTracks)
        : [...elements.map((e) => e.track), ...files.map((f) => f.track)];
    const shiftCues = () => {
      for (const track of textTracks()) {
        for (const cue of Array.from(track.cues ?? [])) {
          const by = (delayMs - (shifted.get(cue) ?? 0)) / 1000;
          if (!by) continue;
          cue.startTime += by;
          cue.endTime += by;
          shifted.set(cue, delayMs);
        }
      }
    };
    const placeCues = () => {
      for (const track of textTracks()) {
        for (const cue of Array.from(track.cues ?? [])) {
          const vtt = cue as VTTCue;
          if (vtt.line !== 'auto' && !placed.has(vtt)) continue;
          placed.add(vtt);
          vtt.snapToLines = false;
          vtt.line = line;
          vtt.lineAlign = 'end';
        }
      }
    };
    // The playlist's subtitles as the browser's own HLS adds them.
    const playlistTextTracks = () => {
      const el = video.current;
      if (!el || hls || !file || !isHls(file.url)) return [];
      const ours = new Set<TextTrack>([
        ...elements.map((e) => e.track),
        ...files.map((f) => f.track),
      ]);
      return Array.from(el.textTracks).filter(
        (t) =>
          !ours.has(t) &&
          !stale.has(t) &&
          (t.kind === 'subtitles' || t.kind === 'captions')
      );
    };
    // The playlist's default audio, which native HLS that can't switch
    // tracks plays.
    const nativeAudio = () =>
      Math.max(0, playlist?.audio.findIndex((r) => r.default) ?? 0);
    const listTracks = () => {
      const audio = video.current && audioTracksOf(video.current);
      const audioTracks: AudioTrack[] = hls
        ? hls.audioTracks.map((t, i) => ({
            enabled: i === hls!.audioTrack,
            label: t.name,
            language: t.lang ?? '',
          }))
        : audio?.length
          ? listed(audio)
          : mode === 'native' && !nativeSwitchesTracks()
            ? (playlist?.audio ?? []).map((r, i) => ({
                enabled: i === nativeAudio(),
                label: r.name,
                language: r.lang ?? '',
              }))
            : [];
      const playlistSubtitles = playlistTextTracks();
      const tracks: EngineTrack[] = [
        ...audioTracks.map((t, i) => ({
          id: String(i),
          type: 'audio' as const,
          label: ownTrackLabel(t.label, t.language, i + 1),
          lang: t.language,
          title: t.label,
        })),
        // The file's text subtitles, as the playlist's WebVTT renditions.
        ...(hls?.subtitleTracks ?? []).map((t, i) => ({
          id: `${HLS_SUBTITLE}${i}`,
          type: 'subtitle' as const,
          label: ownTrackLabel(t.name, t.lang, i + 1),
          lang: t.lang,
          title: t.name,
          forced: t.forced,
          default: t.default,
          file: true,
        })),
        ...playlistSubtitles.map((t, i) => ({
          id: `${NATIVE_SUBTITLE}${i}`,
          type: 'subtitle' as const,
          label: ownTrackLabel(t.label, t.language, i + 1),
          lang: t.language,
          title: t.label,
          file: true,
        })),
        // Native HLS that lists none of the playlist's: picking one goes to
        // hls.js, under the id it gives it there.
        ...(mode === 'native' &&
        !nativeSwitchesTracks() &&
        !playlistSubtitles.length
          ? (playlist?.subtitles ?? []).map((r, i) => ({
              id: `${HLS_SUBTITLE}${i}`,
              type: 'subtitle' as const,
              label: ownTrackLabel(r.name, r.lang, i + 1),
              lang: r.lang,
              title: r.name,
              forced: r.forced,
              default: r.default,
              file: true,
            }))
          : []),
        ...files.map(({ id, label }) => ({
          id,
          type: 'subtitle' as const,
          label,
          external: true,
        })),
      ];
      listedTracks = tracks;
      emit({ type: 'tracks', tracks });
      const on = audioTracks.findIndex((t) => t.enabled);
      set({ audio: on < 0 ? null : String(on) });
    };
    const onTrackLoad = () => {
      placeCues();
      shiftCues();
    };
    const setSubtitle = (id: string | null) => {
      if (casting) {
        subtitleId = id;
        casting.setSubtitle(castSubtitle(id));
        return set({ subtitle: id });
      }
      const at = file?.subtitles.findIndex((s) => s.id === id) ?? -1;
      const shown = elements[at];
      if (shown && shown.readyState >= HTMLTrackElement.LOADED) {
        const fresh = shown.cloneNode() as HTMLTrackElement;
        fresh.addEventListener('load', onTrackLoad);
        shown.removeEventListener('load', onTrackLoad);
        shown.replaceWith(fresh);
        elements[at] = fresh;
      }
      subtitleId = id;
      if (!hls && !nativeSwitchesTracks() && id?.startsWith(HLS_SUBTITLE)) {
        pendingSubtitle = Number(id.slice(HLS_SUBTITLE.length));
        if (toHlsJs('subtitle')) return set({ subtitle: id });
        pendingSubtitle = undefined;
      }
      // hls.js is no longer needed for this subtitle, so the browser's own
      // HLS, lighter and the one casting takes, plays again with its audio.
      if (hls && hlsWhy === 'subtitle' && !id?.startsWith(HLS_SUBTITLE)) {
        if (toNative()) return set({ subtitle: id });
      }
      elements.forEach((e, i) => {
        e.track.mode = file?.subtitles[i]?.id === id ? 'showing' : 'disabled';
      });
      for (const f of files)
        f.track.mode = f.id === id ? 'showing' : 'disabled';
      playlistTextTracks().forEach((t, i) => {
        t.mode = id === `${NATIVE_SUBTITLE}${i}` ? 'showing' : 'disabled';
      });
      if (hls) {
        const own = id?.startsWith(HLS_SUBTITLE)
          ? Number(id.slice(HLS_SUBTITLE.length))
          : -1;
        hls.subtitleDisplay = own >= 0;
        hls.subtitleTrack = own;
      }
      shiftCues();
      set({ subtitle: id });
    };
    const set = (state: EngineState) => emit({ type: 'state', state });
    const cannotPlay = () =>
      emit({
        type: 'failed',
        error: t({
          comment: 'Follows "Playback failed:"',
          message:
            'this browser cannot play this version. Nothing is converted on the server, so try another version, an external player or the desktop app.',
        }),
      });
    const attachFile = (el: HTMLVideoElement, next: EngineFile) => {
      mode = 'file';
      el.src = next.url;
      return () => {};
    };
    /**
     * Reads the address, then plays where it led: in the browser's own HLS
     * unless asked for hls.js or there is none.
     */
    const attachHls = (
      el: HTMLVideoElement,
      next: EngineFile,
      choice: Choice
    ) => {
      const native =
        (choice !== 'hlsjs' && playsHlsNatively(el)) || !Hls.isSupported();
      mode = native ? 'native' : 'hlsjs';
      if (!native && choice === 'auto') hlsWhy = 'no native HLS';
      const abort = new AbortController();
      let stop = () => {};
      const read =
        playlist?.url === next.url || playlist?.asked === next.url
          ? Promise.resolve(playlist)
          : fetchPlaylist(next.url, abort.signal);
      read.then(
        (found) => {
          if (abort.signal.aborted) return;
          if (!found) return unplayable();
          const want = keepAudio;
          keepAudio = undefined;
          const at = found.audio.findIndex((r) => !!want && r.lang === want);
          playlist =
            at < 0 || found.audio[at].default
              ? found
              : {
                  ...found,
                  url: withAudio(found.url, at),
                  audio: found.audio.map((r, i) => ({
                    ...r,
                    default: i === at,
                  })),
                };
          listTracks();
          if (native) {
            el.src = playlist.url;
            return;
          }
          stop = attachHlsJs(el, next, playlist.url);
        },
        () => {
          if (!abort.signal.aborted) unplayable();
        }
      );
      return () => {
        abort.abort();
        stop();
      };
    };
    const attachHlsJs = (
      el: HTMLVideoElement,
      next: EngineFile,
      url: string
    ) => {
      lastFragment = undefined;
      const player = new Hls({
        startPosition: next.startMs / 1000,
      });
      // The playlist's subtitles show only once one is picked.
      player.subtitleDisplay = false;
      hls = player;
      let recovered = false;
      player.on(Events.AUDIO_TRACKS_UPDATED, listTracks);
      player.on(Events.AUDIO_TRACK_SWITCHED, listTracks);
      player.on(Events.SUBTITLE_TRACKS_UPDATED, () => {
        const pending = pendingSubtitle;
        pendingSubtitle = undefined;
        // hls.js picks its own track right after telling of them, so the
        // pick waits for that.
        if (pending !== undefined)
          queueMicrotask(() => {
            if (hls !== player) return;
            player.subtitleDisplay = true;
            player.subtitleTrack = pending;
          });
        listTracks();
      });
      player.on(Events.SUBTITLE_FRAG_PROCESSED, () => {
        placeCues();
        shiftCues();
      });
      player.on(Events.FRAG_LOADED, (_event, { frag }) => {
        if (frag.type !== 'main') return;
        const { loading, loaded } = frag.stats;
        lastFragment = {
          sn: typeof frag.sn === 'number' ? frag.sn : -1,
          bytes: loaded,
          ms: Math.round(loading.end - loading.start),
          durationS: frag.duration,
        };
      });
      player.on(Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
        // Nothing to recover or ask for again: the browser can't decode it.
        if (
          data.details === ErrorDetails.MANIFEST_INCOMPATIBLE_CODECS_ERROR ||
          data.details === ErrorDetails.BUFFER_INCOMPATIBLE_CODECS_ERROR
        )
          return cannotPlay();
        if (data.type === ErrorTypes.MEDIA_ERROR && !recovered) {
          recovered = true;
          return player.recoverMediaError();
        }
        // hls.js has retried by now: the release may have died, which the
        // server knows on the next ask.
        if (data.type === ErrorTypes.NETWORK_ERROR && reread()) return;
        // eslint-disable-next-line lingui/no-unlocalized-strings -- hls.js's own error name
        emit({ type: 'failed', error: `HLS: ${data.details}` });
      });
      player.loadSource(url);
      player.attachMedia(el);
      return () => {
        player.destroy();
        if (hls === player) hls = null;
        for (const track of Array.from(el.textTracks)) {
          const ours =
            elements.some((e) => e.track === track) ||
            files.some((f) => f.track === track);
          if (ours) continue;
          stale.add(track);
          track.mode = 'disabled';
        }
      };
    };
    const removeElements = () => {
      for (const e of elements) e.remove();
      elements = [];
    };

    const open = (next: EngineFile, choice: Choice) => {
      const el = video.current;
      if (!el) return;
      detach();
      removeElements();
      file = next;
      delayMs = next.subtitleDelayMs;
      elements = next.subtitles.map((s) => {
        const track = document.createElement('track');
        track.kind = 'subtitles';
        track.src = s.url;
        track.label = s.label;
        if (s.lang) track.srclang = s.lang;
        el.append(track);
        return track;
      });
      if (next.volume) {
        el.volume = Math.min(1, next.volume.volume);
        el.muted = next.volume.muted;
      }
      // Each read is a new snapshot, whose ranges may have merged since the last.
      const buffered = () => {
        const ranges = el.buffered;
        return Array.from({ length: ranges.length }, (_, i) => ({
          startMs: ranges.start(i) * 1000,
          endMs: ranges.end(i) * 1000,
        }));
      };
      const handlers: Record<string, () => void> = {
        loadedmetadata: () => {
          if (next.startMs) el.currentTime = next.startMs / 1000;
          set({ durationMs: el.duration * 1000 || 0 });
          listTracks();
          if (!announced) emit({ type: 'loaded' });
          announced = true;
        },
        durationchange: () => set({ durationMs: el.duration * 1000 || 0 }),
        playing: () => {
          begun = true;
          set({ started: true, paused: false, waiting: false });
        },
        pause: () => set({ paused: true }),
        play: () => set({ paused: false }),
        waiting: () => set({ waiting: true }),
        canplay: () => set({ waiting: false }),
        timeupdate: () =>
          emit({
            type: 'position',
            positionMs: el.currentTime * 1000,
            buffered: buffered(),
          }),
        progress: () => emit({ type: 'position', buffered: buffered() }),
        volumechange: () => set({ volume: el.volume, muted: el.muted }),
        enterpictureinpicture: () => set({ pictureInPicture: true }),
        leavepictureinpicture: () => set({ pictureInPicture: false }),
        webkitpresentationmodechanged: () =>
          set({
            pictureInPicture:
              (el as WebKitVideo).webkitPresentationMode ===
              'picture-in-picture',
          }),
        ratechange: () => set({ rate: el.playbackRate }),
        ended: () => emit({ type: 'ended' }),
        error: () => {
          if (mode === 'native' && toHlsJs('native failed')) return;
          if (mode !== 'file' && reread()) return;
          cannotPlay();
        },
      };
      // While a cast device plays, the video waits paused and says nothing.
      for (const [event, handler] of Object.entries(handlers)) {
        if (!LOCAL_ONLY_EVENTS.has(event)) continue;
        handlers[event] = () => {
          if (!casting) handler();
        };
      }
      for (const [event, handler] of Object.entries(handlers))
        el.addEventListener(event, handler);
      const audio = audioTracksOf(el);
      const audioEvents = ['addtrack', 'removetrack', 'change'];
      for (const event of audioEvents)
        audio?.addEventListener(event, listTracks);
      for (const e of elements) e.addEventListener('load', onTrackLoad);
      // The browser's own HLS adds the playlist's subtitles as it reads it,
      // and their cues a segment at a time.
      const onTextTrack = (event: TrackEvent) => {
        event.track?.addEventListener('cuechange', onTrackLoad);
        listTracks();
      };
      el.textTracks.addEventListener('addtrack', onTextTrack);
      // Chrome shows a track in its own language once hls.js adds its own,
      // beside the subtitle picked; only the pick shows.
      const onTextTracksChange = () => {
        elements.forEach((e, i) => {
          if (
            e.track.mode === 'showing' &&
            file?.subtitles[i]?.id !== subtitleId
          )
            e.track.mode = 'disabled';
        });
        for (const f of files)
          if (f.track.mode === 'showing' && f.id !== subtitleId)
            f.track.mode = 'disabled';
      };
      el.textTracks.addEventListener('change', onTextTracksChange);
      const onFullscreen = () => set({ fullscreen: isFullscreen() });
      document.addEventListener('fullscreenchange', onFullscreen);
      detach = () => {
        for (const [event, handler] of Object.entries(handlers))
          el.removeEventListener(event, handler);
        for (const event of audioEvents)
          audio?.removeEventListener(event, listTracks);
        for (const e of elements) e.removeEventListener('load', onTrackLoad);
        el.textTracks.removeEventListener('addtrack', onTextTrack);
        el.textTracks.removeEventListener('change', onTextTracksChange);
        for (const track of Array.from(el.textTracks))
          track.removeEventListener('cuechange', onTrackLoad);
        document.removeEventListener('fullscreenchange', onFullscreen);
      };
      onFullscreen();
      // Nor plays at all while a cast session runs, which takes this file.
      el.autoplay = !next.paused && !casting && !castSessionActive();
      if (next.paused) set({ paused: true });
      unattach();
      unattach = isHls(next.url)
        ? attachHls(el, next, choice)
        : attachFile(el, next);
    };
    const resumeAt = (el: HTMLVideoElement, from: EngineFile) => ({
      // Before it has played, as it was asked to open: the track picks
      // that reopen it land as it loads, before autoplay begins.
      startMs:
        begun && el.currentTime > 0 ? el.currentTime * 1000 : from.startMs,
      paused: begun ? held : from.paused,
    });
    /**
     * Reopens HLS where it is: in hls.js, for a subtitle the browser's own
     * can't show or a stream it failed on; in the browser's own, once
     * hls.js isn't needed; or at another address, for an audio track it
     * can't switch to, or for the stream again.
     */
    const reopen = (changes: Partial<EngineFile>, choice: Choice): boolean => {
      const el = video.current;
      if (!el || !file || mode === 'file') return false;
      if (choice === 'hlsjs' && !Hls.isSupported()) return false;
      if (choice === 'native' && !playsHlsNatively(el)) return false;
      const keep = subtitleId;
      open(
        {
          ...file,
          // Where the playlist read for this file led, not asked again; a
          // read still under way is for the address last asked for.
          url: playlist?.asked === file.url ? playlist.url : file.url,
          ...changes,
          ...resumeAt(el, file),
        },
        choice
      );
      reopens++;
      if (keep && !keep.startsWith(HLS_SUBTITLE)) setSubtitle(keep);
      return true;
    };
    const toHlsJs = (why: typeof hlsWhy) => {
      if (mode !== 'native') return false;
      const before = hlsWhy;
      hlsWhy = why;
      if (reopen({}, 'hlsjs')) return true;
      hlsWhy = before;
      return false;
    };
    const toNative = () => {
      const audio = hls?.audioTrack ?? -1;
      return (
        !!playlist &&
        reopen(
          audio >= 0 ? { url: withAudio(playlist.url, audio) } : {},
          'native'
        )
      );
    };
    /**
     * Asks for the stream's HLS address again, where a release that failed
     * mid-stream is passed over for the next one in the failover chain.
     */
    const playingAudio = (): string | undefined => {
      if (hls) return hls.audioTracks[hls.audioTrack]?.lang;
      const audio = video.current && audioTracksOf(video.current);
      if (audio?.length) return listed(audio).find((t) => t.enabled)?.language;
      return playlist?.audio[nativeAudio()]?.lang;
    };
    const reread = () => {
      if (!origin || rereads >= MAX_REREADS) return unplayable();
      rereads++;
      keepAudio = playingAudio();
      playlist = null;
      return reopen(
        { url: origin },
        mode === 'hlsjs' && hlsWhy !== 'no native HLS' ? 'hlsjs' : 'auto'
      );
    };
    /**
     * HLS that leads nowhere playable: the version's own file, which the
     * failover chain also stands behind, or its error video.
     */
    const unplayable = (): boolean => {
      const el = video.current;
      if (!el || !file || !fallbackUrl) {
        emit({
          type: 'failed',
          // eslint-disable-next-line lingui/no-unlocalized-strings -- this fork's HLS is English only, to keep the locale files untouched
          error: 'the server could not open this version.',
        });
        return true;
      }
      open(
        {
          ...file,
          url: fallbackUrl,
          ...resumeAt(el, file),
        },
        'auto'
      );
      fallbackUrl = undefined;
      reopens++;
      return true;
    };
    /** The audio playing, by its place in the playlist's audio group. */
    const audioPlace = (): number => {
      if (hls) return hls.audioTrack;
      const audio = video.current && audioTracksOf(video.current);
      if (audio?.length) return listed(audio).findIndex((t) => t.enabled);
      return playlist ? nativeAudio() : -1;
    };
    /**
     * What a cast device plays: the HLS remux, with the playing track as its
     * default; or the version's file, where it needs no headers.
     */
    const castMedia = (startS: number): CastMedia | null => {
      if (!file) return null;
      const meta = navigator.mediaSession?.metadata;
      const common = {
        title: meta?.title || file.item.Name || '',
        subtitle: meta?.artist || undefined,
        image: meta?.artwork[0]?.src,
        startS,
        paused: held,
        subtitles: file.subtitles.map((s) => ({
          id: s.id,
          url: new URL(s.url, location.href).toString(),
          label: s.label,
          lang: s.lang,
        })),
      };
      if (mode !== 'file' && origin) {
        // The playlist playing, where the remux's own address is known.
        const url = new URL(playlist?.url ?? origin, location.href);
        const audio = audioPlace();
        if (audio >= 0 && playlist)
          url.searchParams.set('audio', String(audio));
        return {
          ...common,
          url: url.toString(),
          contentType: 'application/x-mpegurl',
          hls: true,
        };
      }
      if (file.headers) return null;
      const container = (file.source.Container ?? '').split(',')[0];
      return {
        ...common,
        url: new URL(file.url, location.href).toString(),
        contentType: CONTAINER_TYPES[container] ?? 'video/mp4',
        hls: false,
      };
    };
    /** A subtitle of the page's list, as the cast device knows it. */
    const castSubtitle = (id: string | null) => {
      if (!id) return null;
      if (file?.subtitles.some((s) => s.id === id)) return { id };
      const track = listedTracks.find((t) => t.id === id);
      return track ? { lang: track.lang, name: track.title } : null;
    };
    const startCasting = (device: Casting) => {
      casting = device;
      const el = video.current;
      const atS =
        el && begun && el.currentTime > 0
          ? el.currentTime
          : (file?.startMs ?? 0) / 1000;
      el?.pause();
      const media = castMedia(atS);
      if (!media) {
        casting = null;
        return;
      }
      set({ waiting: true });
      const keep = subtitleId;
      void device.load(media).then((loaded) => {
        if (casting !== device) return;
        if (!loaded) return castFailed();
        if (keep) device.setSubtitle(castSubtitle(keep));
      });
    };
    const castFailed = () => {
      casting = null;
      emit({
        type: 'failed',
        // eslint-disable-next-line lingui/no-unlocalized-strings -- this fork's casting is English only, to keep the locale files untouched
        error: 'the cast device could not play this version.',
      });
    };
    const followCasting = () => {
      if (unfollowCast || !castSdkPossible()) return;
      unfollowCast = followCast({
        started: startCasting,
        status(status) {
          held = status.paused;
          set({
            started: true,
            paused: status.paused,
            waiting: status.waiting,
            ...(status.durationS > 0 && {
              durationMs: status.durationS * 1000,
            }),
            volume: status.volume,
            muted: status.muted,
          });
          emit({ type: 'position', positionMs: status.positionS * 1000 });
        },
        ended: () => emit({ type: 'ended' }),
        failed: castFailed,
        // Back on this device where the cast device was, paused.
        stopped(atS) {
          casting = null;
          held = true;
          const el = video.current;
          if (el && el.readyState > 0) el.currentTime = atS;
          set({ paused: true, waiting: false });
          emit({ type: 'position', positionMs: atS * 1000 });
        },
      });
    };
    const statsText = () => {
      const el = video.current;
      if (!el || !file) return '';
      return videoStatsText({
        video: el,
        mode:
          mode === 'hlsjs' ? { kind: 'hlsjs', why: hlsWhy } : { kind: mode },
        hls,
        reopens,
        lastFragment,
        nativeAudio: playlist?.audio[nativeAudio()]?.name,
      });
    };

    return {
      load(next) {
        pendingSubtitle = undefined;
        subtitleId = null;
        begun = false;
        announced = false;
        held = !!next.paused;
        reopens = 0;
        rereads = 0;
        hlsWhy = 'no native HLS';
        // A version's headers are for its file, so with some there is no
        // falling back to it from HLS, which can't send them.
        const { hlsUrl } = next;
        fallbackUrl = hlsUrl && !next.headers ? next.url : undefined;
        origin = hlsUrl ?? null;
        playlist = null;
        open(hlsUrl ? { ...next, url: hlsUrl } : next, 'auto');
        // A cast session already running plays this file in its place.
        followCasting();
      },
      // Browsers keep a closed player in their media controls until its video drops the stream.
      close() {
        // The cast device plays on; the page only stops following it.
        unfollowCast?.();
        unfollowCast = null;
        casting = null;
        clearInterval(statsTimer);
        statsTimer = 0;
        detach();
        detach = () => {};
        unattach();
        unattach = () => {};
        removeElements();
        const el = video.current;
        if (!el) return;
        el.pause();
        el.removeAttribute('src');
        el.load();
      },
      setPaused(paused) {
        held = paused;
        if (casting) return casting.setPaused(paused);
        const el = video.current;
        if (!el) return;
        if (paused) el.pause();
        else void el.play().catch(() => {});
      },
      seek(ms) {
        if (casting) return casting.seek(ms / 1000);
        if (video.current) video.current.currentTime = ms / 1000;
      },
      setVolume(volume, muted) {
        if (casting) return casting.setVolume(volume, muted);
        const el = video.current;
        if (!el) return;
        el.volume = Math.min(1, volume);
        el.muted = muted;
      },
      setRate(rate) {
        if (casting) return;
        if (video.current) video.current.playbackRate = rate;
      },
      setAudio(id) {
        if (casting) {
          const track = listedTracks.find(
            (t) => t.type === 'audio' && t.id === id
          );
          if (track) casting.setAudio({ lang: track.lang, name: track.title });
          return set({ audio: id });
        }
        if (hls) {
          hls.audioTrack = Number(id);
          set({ audio: id });
          return;
        }
        const audio = video.current && audioTracksOf(video.current);
        if (audio?.length) {
          listed(audio).forEach((t, i) => (t.enabled = String(i) === id));
          set({ audio: id });
          return;
        }
        // Native HLS that can't switch the playlist's audio plays the
        // default, so it reopens where it is with the pick as the default.
        if (
          mode !== 'native' ||
          nativeSwitchesTracks() ||
          !playlist?.audio[Number(id)] ||
          Number(id) === nativeAudio()
        )
          return;
        if (reopen({ url: withAudio(playlist.url, Number(id)) }, 'native'))
          set({ audio: id });
      },
      setSubtitle,
      setSubtitleDelay(ms) {
        delayMs = ms;
        shiftCues();
      },
      setStyle({ subtitleStyle, height }) {
        line = subtitleLine(subtitleStyle, height);
        placeCues();
      },
      toggleFullscreen: toggleDocumentFullscreen,
      stats: {
        pages: STATS_PAGES,
        show(page) {
          clearInterval(statsTimer);
          statsTimer = 0;
          if (!page) return emit({ type: 'stats-text', text: undefined });
          const tick = () => emit({ type: 'stats-text', text: statsText() });
          tick();
          statsTimer = window.setInterval(tick, STATS_MS);
        },
      },
      togglePictureInPicture: pipSupported()
        ? () => {
            const el = video.current as WebKitVideo | null;
            if (!el) return;
            if (document.pictureInPictureEnabled) {
              if (document.pictureInPictureElement === el)
                void document.exitPictureInPicture().catch(() => {});
              else void el.requestPictureInPicture().catch(() => {});
              return;
            }
            el.webkitSetPresentationMode?.(
              el.webkitPresentationMode === 'picture-in-picture'
                ? 'inline'
                : 'picture-in-picture'
            );
          }
        : undefined,
      // Chromecasts through the Cast SDK where the browser has it; else
      // AirPlay, or a cast device the browser reaches with the video's own
      // address: native HLS or a file, never hls.js's Media Source.
      cast:
        castSdkPossible() || 'remote' in HTMLMediaElement.prototype
          ? {
              watch(available) {
                if (!castSdkPossible())
                  return watchRemotePlayback(video.current, available);
                let fallback = () => {};
                const stop = watchCastDevices(available, () => {
                  fallback = watchRemotePlayback(video.current, available);
                });
                return () => {
                  stop();
                  fallback();
                };
              },
              prompt() {
                if (promptCast()) return;
                void video.current?.remote.prompt().catch(() => {});
              },
            }
          : undefined,
      ownText: (id) => files.find((f) => f.id === id)?.text ?? null,
      subtitleFiles: {
        types: SUBTITLE_TYPES,
        add: async (added) => {
          checkSubtitleFile(added, SUBTITLE_TYPES);
          const { text, cues } = await readSubtitleFile(added);
          const el = video.current;
          if (!el) return;
          const track = el.addTextTrack('subtitles', added.name);
          track.mode = 'hidden';
          for (const cue of cues)
            track.addCue(
              new VTTCue(cue.startMs / 1000, cue.endMs / 1000, cue.text)
            );
          const id = `file:${files.length}`;
          files = [...files, { id, label: added.name, track, text }];
          listTracks();
          placeCues();
          setSubtitle(id);
        },
      },
      fits: true,
    };
  };
}
