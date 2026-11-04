import React from 'react';
import { currentHost } from '../hosts';
import { leaveWindowFullscreen } from '../hosts/shell/desktop';

/** Safari's own player, the only full screen an iPhone gives a page. */
type NativeVideo = HTMLVideoElement & {
  webkitEnterFullscreen?(): void;
  webkitExitFullscreen?(): void;
  webkitDisplayingFullscreen?: boolean;
};

type Orientation = ScreenOrientation & {
  lock?(orientation: string): Promise<void>;
  unlock?(): void;
};

/** Older iPads name the fullscreen API with a prefix. */
type PrefixedDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?(): void;
};
type PrefixedElement = HTMLElement & { webkitRequestFullscreen?(): void };

function isPhone(): boolean {
  return (
    matchMedia('(pointer: coarse)').matches &&
    Math.min(screen.width, screen.height) < 600
  );
}

const doc = document as PrefixedDocument;
const root = document.documentElement as PrefixedElement;

/** iPhones have no fullscreen for the page, only for a video. */
const pageCanFullscreen = () =>
  !!root.requestFullscreen || !!root.webkitRequestFullscreen;

const pageFullscreen = () =>
  !!document.fullscreenElement || !!doc.webkitFullscreenElement;

export const isFullscreen = (video?: HTMLVideoElement | null) =>
  pageFullscreen() ||
  !!(video as NativeVideo | null | undefined)?.webkitDisplayingFullscreen ||
  !!currentHost().fullscreen?.active();

/** Calls back whenever full screen starts or ends, for the page or the video. */
export function watchFullscreen(
  video: HTMLVideoElement,
  changed: () => void
): () => void {
  const docEvents = ['fullscreenchange', 'webkitfullscreenchange'];
  const videoEvents = ['webkitbeginfullscreen', 'webkitendfullscreen'];
  for (const e of docEvents) document.addEventListener(e, changed);
  for (const e of videoEvents) video.addEventListener(e, changed);
  return () => {
    for (const e of docEvents) document.removeEventListener(e, changed);
    for (const e of videoEvents) video.removeEventListener(e, changed);
  };
}

// Leaving full screen any way (the back gesture too) frees the rotation again.
let unlockOnExit = false;
function releaseOrientationOnExit(): void {
  if (unlockOnExit) return;
  unlockOnExit = true;
  const release = () => {
    if (pageFullscreen()) return;
    try {
      (screen.orientation as Orientation | undefined)?.unlock?.();
    } catch {
      // Nothing was locked.
    }
  };
  document.addEventListener('fullscreenchange', release);
  document.addEventListener('webkitfullscreenchange', release);
}

/** Phones also turn to landscape, which only a full screen page may lock. */
async function enterFullscreen(video?: HTMLVideoElement | null): Promise<void> {
  const app = currentHost().fullscreen;
  if (app) return app.set(true);
  if (!pageCanFullscreen()) {
    (video as NativeVideo | null | undefined)?.webkitEnterFullscreen?.();
    return;
  }
  if (root.requestFullscreen) await root.requestFullscreen();
  else root.webkitRequestFullscreen?.();
  if (!isPhone()) return;
  releaseOrientationOnExit();
  // Full screen stands without it: some browsers refuse a lock.
  const orientation = screen.orientation as Orientation | undefined;
  await orientation?.lock?.('landscape').catch((error: unknown) => {
    console.warn('Could not turn the screen to landscape:', error);
  });
}

async function exitFullscreen(video?: HTMLVideoElement | null): Promise<void> {
  const app = currentHost().fullscreen;
  if (app?.active()) return app.set(false);
  const native = video as NativeVideo | null | undefined;
  if (native?.webkitDisplayingFullscreen)
    return native.webkitExitFullscreen?.();
  try {
    (screen.orientation as Orientation | undefined)?.unlock?.();
  } catch {
    // Nothing was locked.
  }
  if (document.exitFullscreen) await document.exitFullscreen();
  else doc.webkitExitFullscreen?.();
}

export function leaveFullscreen(video?: HTMLVideoElement | null): void {
  if (isFullscreen(video)) void exitFullscreen(video).catch(() => {});
  else leaveWindowFullscreen();
}

export function toggleDocumentFullscreen(
  video?: HTMLVideoElement | null
): void {
  void (
    isFullscreen(video) ? exitFullscreen(video) : enterFullscreen(video)
  ).catch((error: unknown) => {
    console.warn('Full screen failed:', error);
  });
}

/** Taps on these do their own thing, the full screen button among them. */
const CONTROLS = 'button, a, input, select, textarea, [role="button"]';

/**
 * Phones play full screen in landscape, as their own players do, and tablets in the app either way up.
 * Browsers allow it only just after a tap, so when the page opens too late for that,
 * the next tap on the player enters it. iPhones are left to the button, as theirs is Safari's own player.
 */
export function usePlayerFullscreen(enabled: boolean): void {
  React.useEffect(() => {
    const host = currentHost();
    const tablet =
      !!host.fullscreen && !host.tv && matchMedia('(pointer: coarse)').matches;
    if (!enabled || !(isPhone() || tablet)) return;
    if (!host.fullscreen && !pageCanFullscreen()) return;
    let done = false;
    let retry: ((event: PointerEvent) => void) | undefined;
    const stopRetry = () => {
      if (retry) document.removeEventListener('pointerup', retry, true);
      retry = undefined;
    };
    if (!isFullscreen())
      void enterFullscreen().catch(() => {
        if (done) return;
        retry = (event) => {
          if ((event.target as Element | null)?.closest?.(CONTROLS)) return;
          stopRetry();
          if (!isFullscreen())
            void enterFullscreen().catch((error: unknown) => {
              console.warn('Full screen failed:', error);
            });
        };
        document.addEventListener('pointerup', retry, true);
      });
    return () => {
      done = true;
      stopRetry();
      // The next episode's player keeps it, as it could not enter again without a tap.
      setTimeout(() => {
        const playing = document.documentElement.classList.contains('playing');
        if (!playing && isFullscreen()) void exitFullscreen().catch(() => {});
      });
    };
  }, [enabled]);
}
