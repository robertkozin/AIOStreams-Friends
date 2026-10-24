/* eslint-disable lingui/no-unlocalized-strings -- a test engine, English only, to keep the locale files untouched */
import Hls, { ErrorTypes, Events } from 'hls.js';
import type React from 'react';
import type { JellyfinClient } from '../client';
import type { SourceInfo } from '../types';
import { ownTrackLabel } from './controller';
import type { EngineFactory, EngineTrack, PlayerEngine } from './engine';
import { videoEngine, type Attach } from './video';

/** The version's HLS remux, when the server offers one. */
export function hlsUrl(
  client: JellyfinClient,
  source: SourceInfo
): string | null {
  const url = source.TranscodingUrl;
  if (!url || source.TranscodingSubProtocol !== 'hls') return null;
  const [path, search] = url.split('?');
  const query = Object.fromEntries(new URLSearchParams(search));
  delete query.api_key;
  return client.url(path, { ...query, ApiKey: client.token });
}

/**
 * The page's `<video>` playing the server's HLS remux through hls.js, or the
 * browser's own HLS where it has one. Each of the file's audio tracks is an
 * HLS rendition, so picking one switches without reopening the stream. The
 * server's subtitles stay `<track>`s; the playlist's WebVTT copies are left
 * alone.
 */
export function hlsEngine(
  video: React.RefObject<HTMLVideoElement | null>
): EngineFactory {
  return (emit, opts) => {
    let hls: Hls | null = null;
    // The `<video>` engine's own tracks: subtitles, and audio without hls.js.
    let ownTracks: EngineTrack[] = [];
    const audioTracks = (): EngineTrack[] =>
      (hls?.audioTracks ?? []).map((t, i) => ({
        id: String(i),
        type: 'audio',
        label: ownTrackLabel(t.name, t.lang, i + 1),
        lang: t.lang,
        title: t.name,
        default: t.default,
      }));
    const listTracks = () =>
      emit({
        type: 'tracks',
        tracks: hls
          ? [...audioTracks(), ...ownTracks.filter((t) => t.type !== 'audio')]
          : ownTracks,
      });

    const attach: Attach = (el, file, fail) => {
      if (!Hls.isSupported()) {
        if (!el.canPlayType('application/vnd.apple.mpegurl')) {
          fail('this browser plays no HLS');
          return () => {};
        }
        el.src = file.url;
        return () => {};
      }
      const player = new Hls({
        startPosition: file.startMs / 1000,
        enableWebVTT: false,
      });
      hls = player;
      let recovered = false;
      player.on(Events.AUDIO_TRACKS_UPDATED, listTracks);
      player.on(Events.AUDIO_TRACK_SWITCHED, (_event, data) =>
        emit({ type: 'state', state: { audio: String(data.id) } })
      );
      player.on(Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
        if (data.type === ErrorTypes.NETWORK_ERROR) return player.startLoad();
        if (data.type === ErrorTypes.MEDIA_ERROR && !recovered) {
          recovered = true;
          return player.recoverMediaError();
        }
        fail(`HLS: ${data.details}`);
      });
      player.loadSource(file.url);
      player.attachMedia(el);
      return () => {
        player.destroy();
        if (hls === player) hls = null;
      };
    };

    const inner: PlayerEngine = videoEngine(video, attach)((event) => {
      if (event.type === 'tracks') {
        ownTracks = event.tracks;
        return listTracks();
      }
      // With hls.js the audio state comes from its renditions instead.
      if (hls && event.type === 'state' && 'audio' in event.state) {
        const { audio: _audio, ...rest } = event.state;
        return emit({ ...event, state: rest });
      }
      emit(event);
    }, opts);

    return {
      ...inner,
      setAudio(id) {
        if (!hls) return inner.setAudio(id);
        hls.audioTrack = Number(id);
      },
    };
  };
}
