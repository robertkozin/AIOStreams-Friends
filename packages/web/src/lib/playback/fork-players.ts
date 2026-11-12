/* eslint-disable lingui/no-unlocalized-strings -- apps' names, and this fork's players are English only */

/*
 * This fork's link players, ahead of upstream's in LINK_PLAYERS: an entry
 * with an upstream id and platform takes its place there.
 *
 * Android intents carry only plain extras, so players whose subtitles are a
 * list (MX Player, Just Player, Next Player) get none, and none of them can
 * send a browser back. Sources: each app's docs or source, 2026-11.
 */

type Platform = 'ios' | 'android' | 'macos';

/** The MX Player contract the Android players share: an int position in ms and a title. */
const mxIntent = (pkg: string) =>
  `intent://{url}#Intent;package=${pkg};type=video/*;scheme={scheme};S.title={title};i.position={positionMs};end`;

export const FORK_LINK_PLAYERS: readonly {
  id: string;
  name: string;
  template: string;
  platforms: readonly Platform[];
}[] = [
  {
    // IINA 1.5 allows mpv's `start` (seconds); `weblink` was an alias of `open`.
    id: 'iina',
    name: 'IINA',
    template: 'iina://open?url={encodedUrl}&mpv_start={position}',
    platforms: ['macos'],
  },
  {
    // mpv.app 0.40 or later; it plays what follows the scheme.
    id: 'mpv-app',
    name: 'mpv',
    template: 'mpv://{url}',
    platforms: ['macos'],
  },
  {
    id: 'vidhub',
    name: 'VidHub',
    template:
      'open-vidhub://x-callback-url/play?url={encodedUrl}&sub={subtitles}&position={position}&filename={title}&x-success={returnUrl}&x-error={returnUrl}&x-cancel={returnUrl}',
    platforms: ['ios', 'macos'],
  },
  {
    id: 'senplayer',
    name: 'SenPlayer',
    template: 'senplayer://x-callback-url/play?url={encodedUrl}',
    platforms: ['ios'],
  },
  {
    id: 'mx-player-pro',
    name: 'MX Player Pro',
    template: mxIntent('com.mxtech.videoplayer.pro'),
    platforms: ['android'],
  },
  {
    id: 'just-player',
    name: 'Just Player',
    template: mxIntent('com.brouken.player'),
    platforms: ['android'],
  },
  {
    id: 'next-player',
    name: 'Next Player',
    template: mxIntent('dev.anilbeesetti.nextplayer'),
    platforms: ['android'],
  },
  {
    id: 'kodi',
    name: 'Kodi',
    template:
      'intent://{url}#Intent;package=org.xbmc.kodi;type=video/*;scheme={scheme};end',
    platforms: ['android'],
  },
];
