import { config as appConfig } from '../config/index.js';
import { ConfigProfileRepository } from '../db/repositories/config-profiles.js';
import type { JellyfinPersona } from '../db/schemas.js';
import { playbackNzbHash } from '../debrid/utils.js';
import { unwrapProxyUrl } from '../proxy/token.js';
import {
  noteStreamViewer,
  type StreamViewerHint,
} from '../stream-sessions/viewers.js';
import {
  proxyTargetKey,
  usenetTargetKey,
} from '../stream-sessions/target-key.js';
import { decodeUsenetStreamUrl } from '../usenet/integration/tokens.js';
import type { ClientInfo } from './auth.js';
import type { MediaSourceRecord, PlaybackMemo } from './types.js';

/** The alias a configuration is known by: the operator's, else a saved one. */
async function aliasOf(uuid: string): Promise<string | undefined> {
  for (const [alias, entry] of Object.entries(
    appConfig.api.aliasedConfigurations
  )) {
    if (entry.uuid === uuid) return alias;
  }
  try {
    for (const [alias, target] of await ConfigProfileRepository.aliasMap()) {
      if (target.uuid === uuid) return alias;
    }
  } catch {
    /* the uuid alone still identifies it */
  }
  return undefined;
}

/** What the stream registry will key a version's URL by, as far as it shows. */
function hintFor(record: MediaSourceRecord): StreamViewerHint {
  const unwrapped = unwrapProxyUrl(record.url);
  // A proxied version is a proxy session of the URL it wraps, and the usenet
  // engine's session behind it, if any, is matched by the NZB.
  const proxied = unwrapped !== record.url;
  const token = decodeUsenetStreamUrl(unwrapped);
  return {
    targetKey: proxied
      ? proxyTargetKey(unwrapped)
      : token
        ? usenetTargetKey(token.hash, token.fileIndex, token.innerPath)
        : undefined,
    // A playback link resolves at play time, so only its NZB is known.
    hash: token?.hash ?? playbackNzbHash(unwrapped),
    filename: record.filename ?? token?.filename,
  };
}

function titleOf(memo: PlaybackMemo): string | undefined {
  const name = memo.titleMetadata?.titles?.[0];
  const d = memo.descriptor;
  if (d.k !== 'episode') return name ?? d.i;
  const se = `S${String(d.s).padStart(2, '0')}E${String(d.e).padStart(2, '0')}`;
  return `${name ?? d.i} ${se}`;
}

/**
 * Tell the stream registry which persona is about to play, or is playing, a
 * version, so the dashboard and the logs can name them.
 */
export async function noteJellyfinViewer(
  who: {
    uuid: string;
    persona: JellyfinPersona | null;
    client?: ClientInfo;
    clientIp?: string;
  },
  memo: PlaybackMemo,
  record: MediaSourceRecord | undefined
): Promise<void> {
  if (!record || record.notice || record.live) return;
  noteStreamViewer(
    {
      uuid: who.uuid,
      alias: await aliasOf(who.uuid),
      personaId: who.persona?.id,
      persona: who.persona?.name ?? 'Account',
      client: who.client?.name || undefined,
      device: who.client?.device || undefined,
      title: titleOf(memo),
    },
    { ...hintFor(record), clientIp: who.clientIp }
  );
}
