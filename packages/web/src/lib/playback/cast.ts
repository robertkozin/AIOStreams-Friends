/**
 * Casting to Chromecasts and TVs with Chromecast built in, through Google's
 * Cast SDK, which Chromium browsers (Chrome and Edge, on Android and
 * desktop) load. The browser's own Remote Playback casts the video's address
 * as it is, which the default receiver takes for MPEG-TS HLS; this one tells
 * it the remux's segments are fragmented MP4, and sends the title, artwork,
 * where to start and the subtitles beside the file.
 */

const SDK_URL =
  'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
/** Google's Default Media Receiver. */
const RECEIVER_APP_ID = 'CC1AD845';
const SDK_TIMEOUT_MS = 10_000;
/** Server subtitles are side-loaded under ids clear of the receiver's own. */
const SIDELOADED_TRACK_BASE = 1000;

/* The parts of the SDK used here; it ships no types. */
interface CastTrack {
  trackId: number;
  type: 'AUDIO' | 'TEXT' | 'VIDEO';
  name?: string;
  language?: string;
  trackContentId?: string;
  trackContentType?: string;
  subtype?: string;
}
interface CastMediaInfo {
  contentUrl?: string;
  streamType?: string;
  hlsSegmentFormat?: string;
  hlsVideoSegmentFormat?: string;
  metadata?: unknown;
  tracks?: CastTrack[] | null;
}
interface CastMediaSession {
  idleReason?: string | null;
  activeTrackIds?: number[] | null;
  media?: CastMediaInfo | null;
  editTracksInfo(
    request: unknown,
    ok: () => void,
    fail: (error: unknown) => void
  ): void;
}
interface CastSessionObject {
  loadMedia(request: unknown): Promise<unknown>;
  getMediaSession(): CastMediaSession | null;
  getCastDevice(): { friendlyName?: string };
  endSession(stopCasting: boolean): void;
}
interface RemotePlayer {
  isConnected: boolean;
  isMediaLoaded: boolean;
  isPaused: boolean;
  currentTime: number;
  duration: number;
  volumeLevel: number;
  isMuted: boolean;
  playerState: string | null;
  mediaInfo: CastMediaInfo | null;
}
interface RemotePlayerController extends EventTarget {
  playOrPause(): void;
  seek(): void;
  setVolumeLevel(): void;
  muteOrUnmute(): void;
  stop(): void;
}
interface CastContext extends EventTarget {
  setOptions(options: Record<string, unknown>): void;
  getCastState(): string;
  getCurrentSession(): CastSessionObject | null;
  requestSession(): Promise<unknown>;
  endCurrentSession(stopCasting: boolean): void;
}
interface CastFramework {
  CastContext: { getInstance(): CastContext };
  RemotePlayer: new () => RemotePlayer;
  RemotePlayerController: new (player: RemotePlayer) => RemotePlayerController;
  CastContextEventType: Record<string, string>;
  RemotePlayerEventType: Record<string, string>;
  CastState: Record<string, string>;
  SessionState: Record<string, string>;
}
interface ChromeCastMedia {
  MediaInfo: new (contentId: string, contentType: string) => CastMediaInfo;
  LoadRequest: new (media: CastMediaInfo) => {
    currentTime?: number;
    autoplay?: boolean;
    activeTrackIds?: number[];
  };
  GenericMediaMetadata: new () => {
    title?: string;
    subtitle?: string;
    images?: unknown[];
  };
  Track: new (id: number, type: string) => CastTrack;
  EditTracksInfoRequest: new (activeTrackIds: number[]) => unknown;
}
interface CastGlobals {
  cast?: { framework?: CastFramework };
  chrome?: {
    cast?: {
      isAvailable?: boolean;
      media?: ChromeCastMedia;
      Image: new (url: string) => unknown;
    };
  };
  __onGCastApiAvailable?: (available: boolean) => void;
}

const globals = () => window as unknown as CastGlobals;

/** What to play on the TV. */
export interface CastMedia {
  url: string;
  contentType: string;
  /** The server's HLS remux, whose segments are fragmented MP4. */
  hls: boolean;
  title: string;
  subtitle?: string;
  image?: string;
  startS: number;
  paused: boolean;
  /** Server subtitles, as WebVTT addresses the TV can reach. */
  subtitles: { id: string; url: string; label: string; lang?: string }[];
}

/** A track of the page's own list, matched on the TV by language and name. */
export interface TrackMatch {
  lang?: string;
  name?: string;
}

export interface CastStatus {
  paused: boolean;
  waiting: boolean;
  positionS: number;
  durationS: number;
  volume: number;
  muted: boolean;
}

export interface CastHandlers {
  /** A session began, or was already running when the player opened. */
  started(casting: Casting): void;
  status(status: CastStatus): void;
  ended(): void;
  /** The TV couldn't play what it was sent. */
  failed(): void;
  /** The session is over; `atS` is where the TV was. */
  stopped(atS: number): void;
}

/** A session the player drives. */
export interface Casting {
  device: string;
  load(media: CastMedia): Promise<boolean>;
  setPaused(paused: boolean): void;
  seek(s: number): void;
  setVolume(volume: number, muted: boolean): void;
  setAudio(match: TrackMatch): void;
  /** A server subtitle by its id, one of the file's by match, or none. */
  setSubtitle(pick: { id: string } | TrackMatch | null): void;
}

let sdk: Promise<CastFramework | null> | undefined;

/** Whether this browser may have the Cast SDK: Chromium, outside Apple's. */
export function castSdkPossible(): boolean {
  return (
    typeof window !== 'undefined' &&
    'chrome' in window &&
    !/iPhone|iPad|iPod/.test(navigator.userAgent)
  );
}

/**
 * Loads the SDK once. Null where it can't cast: a browser with casting turned
 * off (Brave), a web view, or one where the script didn't load.
 */
export function loadCastSdk(): Promise<CastFramework | null> {
  if (!castSdkPossible()) return Promise.resolve(null);
  sdk ??= new Promise<CastFramework | null>((resolve) => {
    const g = globals();
    const timer = window.setTimeout(() => resolve(null), SDK_TIMEOUT_MS);
    const done = (framework: CastFramework | null) => {
      window.clearTimeout(timer);
      if (framework) {
        framework.CastContext.getInstance().setOptions({
          receiverApplicationId: RECEIVER_APP_ID,
          autoJoinPolicy: 'origin_scoped',
          resumeSavedSession: true,
        });
      }
      resolve(framework);
    };
    // The framework is a second script the SDK loads after it reports in.
    const whenFramework = () => {
      const started = Date.now();
      const poll = () => {
        const framework = globals().cast?.framework;
        if (framework) return done(framework);
        if (Date.now() - started > SDK_TIMEOUT_MS) return done(null);
        window.setTimeout(poll, 50);
      };
      poll();
    };
    if (g.chrome?.cast?.isAvailable) return whenFramework();
    g.__onGCastApiAvailable = (available) =>
      available ? whenFramework() : done(null);
    const script = document.createElement('script');
    script.src = SDK_URL;
    script.async = true;
    script.onerror = () => done(null);
    document.head.append(script);
  });
  return sdk;
}

/** Reports whether there is a device to cast to, until stopped. */
export function watchCastDevices(
  available: (yes: boolean) => void,
  unavailable: () => void
): () => void {
  let stopped = false;
  let stop = () => {};
  void loadCastSdk().then((framework) => {
    if (stopped) return;
    if (!framework) return unavailable();
    const context = framework.CastContext.getInstance();
    const report = () =>
      available(
        context.getCastState() !== framework.CastState.NO_DEVICES_AVAILABLE
      );
    const type = framework.CastContextEventType.CAST_STATE_CHANGED;
    context.addEventListener(type, report);
    stop = () => context.removeEventListener(type, report);
    report();
  });
  return () => {
    stopped = true;
    stop();
  };
}

/** Whether a cast session runs now, as far as a loaded SDK knows. */
export function castSessionActive(): boolean {
  return !!globals()
    .cast?.framework?.CastContext.getInstance()
    .getCurrentSession();
}

/** Opens the browser's device picker, which also stops a cast. */
export function promptCast(): boolean {
  const framework = globals().cast?.framework;
  if (!framework) return false;
  void framework.CastContext.getInstance()
    .requestSession()
    .catch(() => {});
  return true;
}

/**
 * Follows the cast session for one player: `started` when one begins (or
 * already runs), then the TV's status until it stops. Stopping follows
 * leaves the session and what the TV plays.
 */
export function followCast(handlers: CastHandlers): () => void {
  let stopped = false;
  let unfollow = () => {};
  void loadCastSdk().then((framework) => {
    if (stopped || !framework) return;
    const chromeCast = globals().chrome?.cast;
    const media = chromeCast?.media;
    if (!media) return;
    const context = framework.CastContext.getInstance();
    const player = new framework.RemotePlayer();
    const controller = new framework.RemotePlayerController(player);
    let active: Casting | null = null;
    let lastPositionS = 0;
    let loading = false;
    // Server subtitles of what was loaded last, by id.
    let sideloaded = new Map<string, number>();

    const mediaSession = () => context.getCurrentSession()?.getMediaSession();
    const remoteTracks = () => player.mediaInfo?.tracks ?? [];
    const findTrack = (type: 'AUDIO' | 'TEXT', match: TrackMatch) => {
      const tracks = remoteTracks().filter((t) => t.type === type);
      const lang = match.lang?.toLowerCase();
      const same = (a?: string) => !!a && a.toLowerCase() === lang;
      return (
        tracks.find((t) => same(t.language) && t.name === match.name) ??
        tracks.find((t) => !!match.name && t.name === match.name) ??
        tracks.find((t) => same(t.language))
      );
    };
    const setActive = (type: 'AUDIO' | 'TEXT', id: number | null) => {
      const session = mediaSession();
      if (!session) return;
      const others = (session.activeTrackIds ?? []).filter(
        (active) =>
          remoteTracks().find((t) => t.trackId === active)?.type !== type
      );
      const ids = id === null ? others : [...others, id];
      session.editTracksInfo(
        new media.EditTracksInfoRequest(ids),
        () => {},
        () => {}
      );
    };

    const begin = () => {
      const session = context.getCurrentSession();
      if (!session || active) return;
      active = {
        device: session.getCastDevice().friendlyName ?? 'TV',
        async load(next) {
          const info = new media.MediaInfo(next.url, next.contentType);
          info.contentUrl = next.url;
          info.streamType = 'BUFFERED';
          if (next.hls) {
            info.hlsSegmentFormat = 'fmp4';
            info.hlsVideoSegmentFormat = 'fmp4';
          }
          const metadata = new media.GenericMediaMetadata();
          metadata.title = next.title;
          if (next.subtitle) metadata.subtitle = next.subtitle;
          if (next.image && chromeCast) {
            metadata.images = [new chromeCast.Image(next.image)];
          }
          info.metadata = metadata;
          sideloaded = new Map();
          info.tracks = next.subtitles.map((s, i) => {
            const track = new media.Track(SIDELOADED_TRACK_BASE + i, 'TEXT');
            track.trackContentId = s.url;
            track.trackContentType = 'text/vtt';
            track.subtype = 'SUBTITLES';
            track.name = s.label;
            if (s.lang) track.language = s.lang;
            sideloaded.set(s.id, track.trackId);
            return track;
          });
          const request = new media.LoadRequest(info);
          request.currentTime = next.startS;
          request.autoplay = !next.paused;
          loading = true;
          try {
            await session.loadMedia(request);
            return true;
          } catch {
            return false;
          } finally {
            loading = false;
          }
        },
        setPaused(paused) {
          if (player.isPaused !== paused) controller.playOrPause();
        },
        seek(s) {
          player.currentTime = s;
          controller.seek();
        },
        setVolume(volume, muted) {
          player.volumeLevel = Math.min(1, volume);
          controller.setVolumeLevel();
          if (player.isMuted !== muted) controller.muteOrUnmute();
        },
        setAudio(match) {
          const track = findTrack('AUDIO', match);
          if (track) setActive('AUDIO', track.trackId);
        },
        setSubtitle(pick) {
          if (!pick) return setActive('TEXT', null);
          const id =
            'id' in pick
              ? sideloaded.get(pick.id)
              : findTrack('TEXT', pick)?.trackId;
          if (id !== undefined) setActive('TEXT', id);
        },
      };
      handlers.started(active);
    };

    const onChange = () => {
      if (!player.isConnected) {
        if (active) {
          active = null;
          handlers.stopped(lastPositionS);
        }
        return;
      }
      begin();
      if (!active || loading) return;
      if (player.isMediaLoaded) lastPositionS = player.currentTime;
      if (player.playerState === 'IDLE') {
        const reason = mediaSession()?.idleReason;
        if (reason === 'FINISHED') handlers.ended();
        if (reason === 'ERROR') handlers.failed();
        return;
      }
      if (!player.isMediaLoaded) return;
      handlers.status({
        paused: player.isPaused,
        waiting: player.playerState === 'BUFFERING',
        positionS: player.currentTime,
        durationS: player.duration,
        volume: player.volumeLevel,
        muted: player.isMuted,
      });
    };
    const anyChange = framework.RemotePlayerEventType.ANY_CHANGE;
    controller.addEventListener(anyChange, onChange);
    unfollow = () => controller.removeEventListener(anyChange, onChange);
    if (player.isConnected) begin();
  });
  return () => {
    stopped = true;
    unfollow();
  };
}
