/* eslint-disable lingui/no-unlocalized-strings -- this fork's Play in choice is English only, to keep the locale files untouched */
import { currentHost } from '@/lib/hosts';
import { settings, type PlayerEngine } from '@/lib/settings';
import {
  canPlayWithWebGpu,
  chosenPlayer,
  CUSTOM_LINK,
  playerOptions,
} from './player-choice';

/*
 * Where Play sends a version from the page, as one list over upstream's two
 * settings: an engine (Settings → Playback → Engine) or another app (Play
 * versions in).
 */

/** The page's own engines. */
export type EngineId = 'webgpu' | 'hls' | 'browser';

const ENGINES: readonly string[] = ['webgpu', 'hls', 'browser'];
export const isPageEngine = (value: string): value is EngineId =>
  ENGINES.includes(value);

/** Where the page itself plays: not in an app's own player, nor on a TV's. */
export const pagePlays = () => !currentHost().play && !currentHost().player;

/**
 * The page's engines for the Engine setting, each passing what it can't play
 * to the next. Automatic, as upstream's Settings shows it, is WebGPU where it
 * can play and the HLS remux elsewhere. The browser's own player never passes
 * a version on, so it comes last, or alone where it is chosen.
 */
export function engineOrder(): EngineId[] {
  const engine: PlayerEngine = settings.player.engine.read();
  const webGpu = canPlayWithWebGpu();
  if (engine === 'browser') return ['browser'];
  if (engine === 'hls' || !webGpu)
    return webGpu ? ['hls', 'webgpu', 'browser'] : ['hls', 'browser'];
  return ['webgpu', 'hls', 'browser'];
}

/** The choice: the engine the page starts with, or a link player's id. */
export function readPlayIn(): string {
  const player = chosenPlayer();
  return player.kind === 'link' ? player.id : engineOrder()[0];
}

export function playInOptions(): { value: string; label: string }[] {
  const custom = !!settings.player.link.read().trim();
  return [
    ...(canPlayWithWebGpu()
      ? [{ value: 'webgpu', label: 'Browser: WebGPU' }]
      : []),
    { value: 'hls', label: 'Browser: HLS' },
    { value: 'browser', label: 'Browser: Native' },
    ...playerOptions([])
      .filter(
        ({ value }) => value !== 'app' && (value !== CUSTOM_LINK || custom)
      )
      .map(({ value, label }) => ({ value, label: `External: ${label}` })),
  ];
}

/** Remembers the choice for every Play after. */
export function writePlayIn(value: string): void {
  if (isPageEngine(value)) {
    settings.player.choice.write('app');
    settings.player.engine.write(value);
  } else settings.player.choice.write(value);
}

/**
 * Set as the player hands its version to another app from this list, so the
 * prompt that follows leaves the player as it closes; other prompts don't.
 */
let handingOff = false;
export const markHandOff = (on: boolean) => {
  handingOff = on;
};
export function takeHandOff(): boolean {
  const was = handingOff;
  handingOff = false;
  return was;
}
