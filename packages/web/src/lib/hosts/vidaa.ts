/* eslint-disable lingui/no-unlocalized-strings -- the fork's own strings, left untranslated */
import type { Host } from '.';
import { isTextField, runAction } from '../input';

declare global {
  interface Window {
    Hisense_GetOSVersion?(): string;
    Hisense_GetModelName?(): string;
    Hisense_Exit?(): void;
    Hisense_CloseApp?(): void;
  }
}

/** The browser may not get Hisense's API, but its user agent names VIDAA. */
const detected = () =>
  typeof window.Hisense_GetOSVersion === 'function' ||
  /VIDAA/i.test(navigator.userAgent);

function device(): { name: string } {
  try {
    const model = window.Hisense_GetModelName?.();
    if (model) return { name: `Hisense ${model}` };
  } catch {}
  return { name: 'VIDAA TV' };
}

function exit(): void {
  if (window.Hisense_Exit) window.Hisense_Exit();
  else if (window.Hisense_CloseApp) window.Hisense_CloseApp();
  else window.close();
}

/** The web view ignores the page's 1280 wide viewport, so the page's rem sizes are scaled to the width instead. */
function fitToScreen(): void {
  const style = document.createElement('style');
  style.textContent = 'html { font-size: calc(100vw / 80); }';
  document.head.append(style);
}

const BACKSPACE = 8;

/** The remote's Back button sends Backspace's code, which the page reads as Backspace. */
function backButton(): void {
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.keyCode !== BACKSPACE || isTextField(e.target as Element | null))
        return;
      if (!runAction('back')) return;
      e.preventDefault();
      e.stopPropagation();
    },
    true
  );
}

function create(): Host | null {
  if (!detected()) return null;
  fitToScreen();
  backButton();
  return {
    name: 'vidaa',
    tv: true,
    device,
    // Back from Home, once it has moved into the navigation, leaves the app.
    back: () => {
      if (!document.querySelector('[data-page="home"]:not([inert])'))
        return false;
      exit();
      return true;
    },
    exit,
  };
}

let host: Host | null | undefined;

/**
 * Hisense's TVs and projectors, in their browser or as a web app on the
 * launcher. Their `<video>` decodes HEVC, HDR and Dolby Vision in hardware
 * and plays the file itself, so the page plays there without the HLS remux.
 */
export function vidaaHost(): Host | null {
  if (host === undefined) host = create();
  return host;
}
