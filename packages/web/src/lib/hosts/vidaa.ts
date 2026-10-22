/* eslint-disable lingui/no-unlocalized-strings -- the fork's own strings, left untranslated */
import type { Host } from '.';

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
  else window.Hisense_CloseApp?.();
}

function create(): Host | null {
  if (!detected()) return null;
  return {
    name: 'vidaa',
    tv: true,
    device,
    // Where Hisense's API is missing, Back on the first page leaves it to the browser.
    ...((window.Hisense_Exit || window.Hisense_CloseApp) && { exit }),
  };
}

let host: Host | null | undefined;

/**
 * Hisense's TVs and projectors, in their browser or as a web app on the
 * launcher. Their `<video>` decodes HEVC, HDR and Dolby Vision in hardware,
 * which Movi can't, so the page plays there.
 */
export function vidaaHost(): Host | null {
  if (host === undefined) host = create();
  return host;
}
