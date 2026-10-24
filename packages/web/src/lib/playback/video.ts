import { t } from '@lingui/core/macro';
import Hls, { ErrorTypes, Events } from 'hls.js';
import type React from 'react';
import { checkSubtitleFile, readSubtitleFile } from '../subtitles/files';
import { subtitleLine } from '../subtitles/style';
import { ownTrackLabel } from './controller';
import type {
  EngineFactory,
  EngineFile,
  EngineState,
  EngineTrack,
} from './engine';
import { isFullscreen, toggleDocumentFullscreen } from './fullscreen';

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

const pipSupported = () =>
  document.pictureInPictureEnabled ||
  'webkitSupportsPresentationMode' in HTMLVideoElement.prototype;

/**
 * Safari's own HLS, which AirPlay takes and hls.js's Media Source can't
 * offer, along with its own picture in picture and track menus.
 */
const prefersNativeHls = (el: HTMLVideoElement) =>
  'WebKitPlaybackTargetAvailabilityEvent' in window &&
  !!el.canPlayType('application/vnd.apple.mpegurl');

const isHls = (url: string) =>
  new URL(url, location.href).pathname.toLowerCase().endsWith('.m3u8');

/**
 * The page's own `<video>`. The server's subtitles are `<track>`s, and files
 * the user adds are text tracks after them. An HLS address plays through
 * hls.js where the browser has Media Source, and the browser's own HLS where
 * it doesn't; its audio tracks are then the playlist's.
 */
export function videoEngine(
  video: React.RefObject<HTMLVideoElement | null>
): EngineFactory {
  return (emit) => {
    let file: EngineFile | null = null;
    let hls: Hls | null = null;
    let elements: HTMLTrackElement[] = [];
    let files: FileTrack[] = [];
    let delayMs = 0;
    let line = subtitleLine();
    let detach = () => {};
    let unattach = () => {};
    // Cues load late, and an HLS track's a segment at a time, so each cue
    // remembers the shift it has.
    const shifted = new WeakMap<TextTrackCue, number>();
    // Browsers disagree on where a cue the file leaves unplaced goes.
    const placed = new WeakSet<VTTCue>();

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
        (t) => !ours.has(t) && (t.kind === 'subtitles' || t.kind === 'captions')
      );
    };
    const listTracks = () => {
      const audio = video.current && audioTracksOf(video.current);
      const audioTracks: AudioTrack[] = hls
        ? hls.audioTracks.map((t, i) => ({
            enabled: i === hls!.audioTrack,
            label: t.name,
            language: t.lang ?? '',
          }))
        : audio
          ? listed(audio)
          : [];
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
        ...playlistTextTracks().map((t, i) => ({
          id: `${NATIVE_SUBTITLE}${i}`,
          type: 'subtitle' as const,
          label: ownTrackLabel(t.label, t.language, i + 1),
          lang: t.language,
          title: t.label,
          file: true,
        })),
        ...files.map(({ id, label }) => ({
          id,
          type: 'subtitle' as const,
          label,
          external: true,
        })),
      ];
      emit({ type: 'tracks', tracks });
      const on = audioTracks.findIndex((t) => t.enabled);
      set({ audio: on < 0 ? null : String(on) });
    };
    const setSubtitle = (id: string | null) => {
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
    const attachFile = (el: HTMLVideoElement, next: EngineFile) => {
      el.src = next.url;
      return () => {};
    };
    const attachHls = (el: HTMLVideoElement, next: EngineFile) => {
      if (!Hls.isSupported() || prefersNativeHls(el))
        return attachFile(el, next);
      const player = new Hls({
        startPosition: next.startMs / 1000,
      });
      // The playlist's subtitles show only once one is picked.
      player.subtitleDisplay = false;
      hls = player;
      let recovered = false;
      player.on(Events.AUDIO_TRACKS_UPDATED, listTracks);
      player.on(Events.AUDIO_TRACK_SWITCHED, listTracks);
      player.on(Events.SUBTITLE_TRACKS_UPDATED, listTracks);
      player.on(Events.SUBTITLE_FRAG_PROCESSED, () => {
        placeCues();
        shiftCues();
      });
      player.on(Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
        if (data.type === ErrorTypes.NETWORK_ERROR) return player.startLoad();
        if (data.type === ErrorTypes.MEDIA_ERROR && !recovered) {
          recovered = true;
          return player.recoverMediaError();
        }
        // eslint-disable-next-line lingui/no-unlocalized-strings -- hls.js's own error name
        emit({ type: 'failed', error: `HLS: ${data.details}` });
      });
      player.loadSource(next.url);
      player.attachMedia(el);
      return () => {
        player.destroy();
        if (hls === player) hls = null;
      };
    };
    const removeElements = () => {
      for (const e of elements) e.remove();
      elements = [];
    };

    return {
      load(next) {
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
        const buffered = () =>
          Array.from({ length: el.buffered.length }, (_, i) => ({
            startMs: el.buffered.start(i) * 1000,
            endMs: el.buffered.end(i) * 1000,
          }));
        const handlers: Record<string, () => void> = {
          loadedmetadata: () => {
            if (next.startMs) el.currentTime = next.startMs / 1000;
            set({ durationMs: el.duration * 1000 || 0 });
            listTracks();
            emit({ type: 'loaded' });
          },
          durationchange: () => set({ durationMs: el.duration * 1000 || 0 }),
          playing: () => set({ started: true, paused: false, waiting: false }),
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
          error: () =>
            emit({
              type: 'failed',
              error: t({
                comment: 'Follows "Playback failed:"',
                message:
                  'this browser cannot play this version. Nothing is converted on the server, so try another version, an external player or the desktop app.',
              }),
            }),
        };
        for (const [event, handler] of Object.entries(handlers))
          el.addEventListener(event, handler);
        const audio = audioTracksOf(el);
        const audioEvents = ['addtrack', 'removetrack', 'change'];
        for (const event of audioEvents)
          audio?.addEventListener(event, listTracks);
        const onTrackLoad = () => {
          placeCues();
          shiftCues();
        };
        for (const e of elements) e.addEventListener('load', onTrackLoad);
        // The browser's own HLS adds the playlist's subtitles as it reads it,
        // and their cues a segment at a time.
        const onTextTrack = (event: TrackEvent) => {
          event.track?.addEventListener('cuechange', onTrackLoad);
          listTracks();
        };
        el.textTracks.addEventListener('addtrack', onTextTrack);
        const onFullscreen = () => set({ fullscreen: isFullscreen() });
        document.addEventListener('fullscreenchange', onFullscreen);
        detach = () => {
          for (const [event, handler] of Object.entries(handlers))
            el.removeEventListener(event, handler);
          for (const event of audioEvents)
            audio?.removeEventListener(event, listTracks);
          for (const e of elements) e.removeEventListener('load', onTrackLoad);
          el.textTracks.removeEventListener('addtrack', onTextTrack);
          for (const track of Array.from(el.textTracks))
            track.removeEventListener('cuechange', onTrackLoad);
          document.removeEventListener('fullscreenchange', onFullscreen);
        };
        onFullscreen();
        el.autoplay = !next.paused;
        if (next.paused) set({ paused: true });
        unattach();
        unattach = isHls(next.url) ? attachHls(el, next) : attachFile(el, next);
      },
      // Browsers keep a closed player in their media controls until its video drops the stream.
      close() {
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
        const el = video.current;
        if (!el) return;
        if (paused) el.pause();
        else void el.play().catch(() => {});
      },
      seek(ms) {
        if (video.current) video.current.currentTime = ms / 1000;
      },
      setVolume(volume, muted) {
        const el = video.current;
        if (!el) return;
        el.volume = Math.min(1, volume);
        el.muted = muted;
      },
      setRate(rate) {
        if (video.current) video.current.playbackRate = rate;
      },
      setAudio(id) {
        if (hls) {
          hls.audioTrack = Number(id);
          set({ audio: id });
          return;
        }
        const audio = video.current && audioTracksOf(video.current);
        if (!audio) return;
        listed(audio).forEach((t, i) => (t.enabled = String(i) === id));
        set({ audio: id });
      },
      setSubtitle,
      setSubtitleDelay(ms) {
        delayMs = ms;
        shiftCues();
      },
      setStyle({ subtitleStyle, lift }) {
        line = subtitleLine(subtitleStyle, lift);
        placeCues();
      },
      toggleFullscreen: toggleDocumentFullscreen,
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
      // AirPlay, or a cast device the browser reaches with the video's own
      // address; never one fed through Media Source.
      cast:
        'remote' in HTMLMediaElement.prototype
          ? {
              watch(available) {
                const remote = video.current?.remote;
                if (!remote) {
                  available(false);
                  return () => {};
                }
                let id: number | undefined;
                let stopped = false;
                remote
                  .watchAvailability(available)
                  .then((n) => {
                    id = n;
                    if (stopped)
                      void remote.cancelWatchAvailability(n).catch(() => {});
                  })
                  .catch(() => available(false));
                return () => {
                  stopped = true;
                  if (id !== undefined)
                    void remote.cancelWatchAvailability(id).catch(() => {});
                };
              },
              prompt() {
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
