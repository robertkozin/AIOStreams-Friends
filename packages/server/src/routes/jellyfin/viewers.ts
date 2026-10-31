import type { Request } from 'express';
import {
  createLogger,
  noteJellyfinViewer,
  resolveByItem,
  type MediaSourceRecord,
  type PlaybackMemo,
} from '@aiostreams/core';
import type { JellyfinRequestContext } from './context.js';
import { pickSource } from './playback.js';

const logger = createLogger('jellyfin');

/** Names the persona behind a version for the stream dashboard and the logs. */
export function noteViewer(
  req: Request,
  ctx: JellyfinRequestContext,
  memo: PlaybackMemo | null | undefined,
  record: MediaSourceRecord | undefined
): void {
  if (!memo) return;
  noteJellyfinViewer(
    {
      uuid: ctx.uuid,
      persona: ctx.persona,
      client: ctx.client,
      clientIp: req.requestIp ?? req.ip,
    },
    memo,
    record
  ).catch((err) => logger.debug({ err }, 'failed to note stream viewer'));
}

/** The same from a playing report, which names the item and maybe a version. */
export async function notePlaying(
  req: Request,
  ctx: JellyfinRequestContext,
  itemId: string,
  mediaSourceId: string | undefined
): Promise<void> {
  // Without a version, the note PlaybackInfo left is the better guess.
  if (!mediaSourceId) return;
  const memo = await resolveByItem(ctx.uuid, ctx.scope(), itemId).catch(
    () => null
  );
  if (!memo) return;
  noteViewer(
    req,
    ctx,
    memo,
    pickSource(memo, mediaSourceId === itemId ? undefined : mediaSourceId)
  );
}
