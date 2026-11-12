/* eslint-disable lingui/no-unlocalized-strings -- this fork's Play in choice is English only, to keep the locale files untouched */
import React from 'react';
import { toast } from 'sonner';
import { Select } from '@aiostreams/ui/select';
import { onSettingsChange } from '@/lib/settings';
import { useParty } from '@/lib/party/party';
import { restartPlayback, stopPlayback } from '@/lib/playback/session';
import { to } from '@/lib/paths';
import type { SourceInfo } from '@/lib/jellyfin/types';
import { usePlay } from '@/features/player/use-play';
import {
  isPageEngine,
  markHandOff,
  pagePlays,
  playInOptions,
  readPlayIn,
  writePlayIn,
} from '@/lib/playback/play-in';
import type { Request } from './version-list';

/**
 * Where the versions play, remembered for every Play after. Over the player
 * a pick also applies to what plays: an engine restarts the player where it
 * is, and another app gets the version from there as Play gives it one,
 * while the player pauses and leaves. A party plays one way for everyone,
 * so the list is left out of it.
 */
export function PlayInSelect({
  request,
  sources,
  onDone,
  onExternal,
}: {
  request: Request;
  sources: SourceInfo[];
  onDone: () => void;
  onExternal: () => void;
}) {
  const value = React.useSyncExternalStore(onSettingsChange, readPlayIn);
  const party = useParty()?.status === 'live';
  const play = usePlay();
  if (!pagePlays() || party) return null;
  const options = playInOptions();

  const applyToPlayer = (next: string) => {
    const { item, here } = request;
    const source = sources.find((s) => s.Id === request.playing);
    if (!here || !source) return;
    onDone();
    // A live channel starts again where it is now, not at a point in it.
    const startMs = source.IsInfiniteStream ? 0 : here.positionMs();
    if (isPageEngine(next)) return restartPlayback(startMs);
    here.pause();
    // An app that can't come back is asked about with the prompt, which
    // leaves the player as it closes; one that can, leaves it now.
    let asked = false;
    markHandOff(true);
    play(item, {
      source,
      startMs,
      playlist: request.playlist,
      onExternal: () => {
        asked = true;
        onExternal();
      },
    }).then(
      () => {
        if (asked) return;
        markHandOff(false);
        stopPlayback(to.item(item.Id!));
      },
      (e: Error) => {
        markHandOff(false);
        toast.error(e.message);
      }
    );
  };

  return (
    <div data-ui="versions-play-in" className="flex items-center gap-2">
      <span className="flex-none text-sm text-[--muted]">Play in</span>
      <Select
        size="sm"
        fieldClass="w-auto"
        className="w-auto rounded-full"
        options={options}
        value={value}
        onValueChange={(next) => {
          writePlayIn(next);
          if (request.playing) applyToPlayer(next);
        }}
      />
    </div>
  );
}
