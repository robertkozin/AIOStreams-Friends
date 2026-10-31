import {
  StreamSessionRepository,
  type StreamHistoryQuery,
  type StreamSessionRow,
} from '../db/repositories/stream-sessions.js';
import { appConfig } from '../utils/index.js';
import { createLogger } from '../logging/logger.js';
import { streamRegistry, STALE_SESSION_MS } from './registry.js';
import { refreshStreamBans } from './bans.js';
import {
  bandwidthBreakdown,
  currentPeriodStart,
  globalBandwidthLimit,
  refreshBandwidthUsage,
  userBandwidthLimit,
  type BandwidthUserSeries,
  type BandwidthWindow,
} from './bandwidth.js';
import { connectionLimitFor, globalConnectionLimit } from './limits.js';
import type { LiveStreamSession } from './types.js';
import { withViewers, type StreamViewer } from './viewers.js';

const logger = createLogger('streams');

const DAY_MS = 86_400_000;

/**
 * Rollups are kept far longer than session rows so the yearly view survives
 * history pruning. Matches the usenet metrics retention.
 */
const BANDWIDTH_RETENTION_DAYS = 400;

/**
 * A row not rewritten for this long has no live owner, so a stop request would
 * never be picked up. Several flush intervals, to tolerate a slow flush.
 */
const ORPHAN_STOP_MS = 60_000;

export interface LiveStreamsSnapshot {
  streams: Array<LiveStreamSession & { viewers?: StreamViewer[] }>;
  summary: {
    /** Sessions actually pushing bytes. */
    streaming: number;
    /** Open but quiet: a paused or fully-buffered player. */
    paused: number;
    /** No open request: between seeks, or done but not yet aged out. */
    idle: number;
    totalBytesPerSec: number;
    /** Instance-wide concurrent-stream cap; 0 when unlimited. */
    connectionLimit: number;
  };
}

/**
 * Active sessions for the dashboard. Local sessions come from the registry
 * (fresh to the millisecond); sessions owned by another replica are folded in
 * from the DB, which is as current as that replica's last flush.
 */
export async function getLiveStreams(
  now = Date.now()
): Promise<LiveStreamsSnapshot> {
  const local = streamRegistry.snapshot(now);
  const streams = [...local];
  try {
    const seen = new Set(local.map((s) => s.id));
    for (const row of await StreamSessionRepository.listActive()) {
      if (row.instanceId === streamRegistry.instanceId || seen.has(row.id)) {
        continue;
      }
      streams.push(rowToLive(row, now));
    }
  } catch (err) {
    logger.debug({ err }, 'failed to read remote active streams');
  }
  streams.sort((a, b) => b.startedAt - a.startedAt);
  const count = (activity: LiveStreamSession['activity']) =>
    streams.filter((s) => s.activity === activity).length;
  return {
    streams: await withViewers(streams),
    summary: {
      streaming: count('streaming'),
      paused: count('paused'),
      idle: count('idle'),
      totalBytesPerSec: streams.reduce((n, s) => n + s.bytesPerSec, 0),
      connectionLimit: globalConnectionLimit(),
    },
  };
}

/**
 * A remote replica's row rendered as a live session. Its rate and read count
 * are only known as of that replica's last flush, so it is reported as idle
 * rather than guessed at.
 */
function rowToLive(row: StreamSessionRow, now = Date.now()): LiveStreamSession {
  return {
    id: row.id,
    transport: row.transport,
    username: row.username,
    clientIp: row.clientIp,
    targetKey: row.targetKey,
    filename: row.filename,
    displayUrl: row.displayUrl,
    size: row.size,
    bytesServed: row.bytesServed,
    requests: row.requests,
    startedAt: row.startedAt,
    lastSeenAt: row.lastSeenAt,
    activeReads: 0,
    activity: 'idle',
    idleMs: Math.max(0, now - row.lastSeenAt),
    start: 0,
    currentBytes: 0,
    bytesPerSec: 0,
    instanceId: row.instanceId,
  };
}

export async function getStreamHistory(query: StreamHistoryQuery): Promise<{
  entries: Array<StreamSessionRow & { viewers?: StreamViewer[] }>;
  total: number;
}> {
  const { entries, total } = await StreamSessionRepository.listHistory(query);
  return { entries: await withViewers(entries), total };
}

/** Remove finished sessions: the given ids, or all of them. */
export async function deleteStreamHistory(ids?: string[]): Promise<number> {
  return ids === undefined
    ? StreamSessionRepository.clearHistory()
    : StreamSessionRepository.deleteHistory(ids);
}

/**
 * Stop one session. One this process owns dies immediately; one owned by
 * another replica is flagged and stopped on that replica's next flush. A row
 * whose owner has gone silent is closed outright, since nothing is left to act
 * on the flag.
 */
export async function stopStream(id: string): Promise<boolean> {
  if (streamRegistry.kill(id, 'stopped')) return true;
  const row = await StreamSessionRepository.get(id);
  if (!row || row.endedAt !== undefined) return false;
  if (Date.now() - row.lastSeenAt > ORPHAN_STOP_MS) {
    logger.info({ id }, 'stopping a stream whose owner is gone');
    return StreamSessionRepository.endById(id, 'stale');
  }
  return StreamSessionRepository.requestStop(id);
}

/**
 * Stop a user's sessions on this replica and any other. Pass `targetKey` to
 * stop only what they have open for one target.
 */
export async function stopUserStreams(
  username: string,
  targetKey?: string
): Promise<number> {
  const local = streamRegistry.killUser(username, 'stopped', targetKey);
  let remote = 0;
  try {
    for (const row of await StreamSessionRepository.listActive()) {
      if (row.username !== username) continue;
      if (targetKey !== undefined && row.targetKey !== targetKey) continue;
      if (row.instanceId === streamRegistry.instanceId) continue;
      if (await StreamSessionRepository.requestStop(row.id)) remote++;
    }
  } catch (err) {
    logger.debug({ err, username }, 'failed to request remote stream stops');
  }
  return local + remote;
}

export interface StreamBandwidthOverview {
  window: BandwidthWindow;
  generatedAt: number;
  sinceMs: number;
  bucketMs: number;
  /** Start of the configured accounting period, whatever window is shown. */
  periodStart: number;
  periodMode: 'rolling' | 'monthly';
  total: number;
  byTransport: Record<'usenet' | 'proxy', number>;
  byUser: Array<{
    username: string;
    bytes: number;
    /** The user's cap in bytes; 0 when unlimited. */
    limit: number;
    /** Concurrent-stream cap; 0 when unlimited. */
    connectionLimit: number;
  }>;
  series: Array<{ bucketMs: number; bytes: number }>;
  /** The same buckets split per user, capped and folded for the chart. */
  seriesByUser: BandwidthUserSeries[];
  globalLimit: number;
  /** Bytes served this accounting period, which is what caps measure. */
  periodTotal: number;
}

export async function getBandwidthOverview(
  window: BandwidthWindow,
  now = Date.now()
): Promise<StreamBandwidthOverview> {
  // Viewing the period itself needs only one query.
  const [breakdown, period] = await Promise.all([
    bandwidthBreakdown(window, now),
    window === '30d' ? undefined : bandwidthBreakdown('30d', now),
  ]);
  return {
    window,
    generatedAt: now,
    sinceMs: breakdown.sinceMs,
    bucketMs: breakdown.bucketMs,
    periodStart: currentPeriodStart(now),
    periodMode: appConfig.streams.bandwidth.periodMode,
    total: breakdown.total,
    byTransport: breakdown.byTransport,
    byUser: breakdown.byUser.map((u) => ({
      ...u,
      limit: userBandwidthLimit(u.username),
      connectionLimit: connectionLimitFor(u.username),
    })),
    series: breakdown.series,
    seriesByUser: breakdown.seriesByUser,
    globalLimit: globalBandwidthLimit(),
    periodTotal: period ? period.total : breakdown.total,
  };
}

/** Flush the registry to the DB. Driven by the `streams-flush` task. */
export async function flushStreamSessions(): Promise<{
  written: number;
  ended: number;
}> {
  return streamRegistry.flush();
}

/**
 * Drop history and rollups past their retention. Bans that have expired go
 * too, since only live ones are ever consulted.
 *
 * Rows abandoned by a replica that never came back are closed out first:
 * retention only deletes finished sessions, so an orphan is otherwise
 * un-prunable until a restart.
 */
export async function pruneStreamSessions(): Promise<number> {
  const now = Date.now();
  const retentionDays = appConfig.streams.historyRetentionDays;
  const stale = await StreamSessionRepository.endStale(
    now - STALE_SESSION_MS,
    now
  );
  const [sessions, bandwidth, bans] = await Promise.all([
    retentionDays > 0
      ? StreamSessionRepository.pruneOlderThan(now - retentionDays * DAY_MS)
      : Promise.resolve(0),
    StreamSessionRepository.pruneBandwidthOlderThan(
      now - BANDWIDTH_RETENTION_DAYS * DAY_MS
    ),
    StreamSessionRepository.pruneExpiredBans(now),
  ]);
  return stale + sessions + bandwidth + bans;
}

/**
 * Boot-time setup: close out rows this process left behind after a crash, and
 * prime the caches admission reads from. Without the priming, bans and
 * bandwidth caps would not be enforced until the first flush.
 */
export async function recoverStreamSessions(): Promise<number> {
  const [orphans] = await Promise.all([
    streamRegistry.recoverOrphans(),
    refreshStreamBans(),
    refreshBandwidthUsage(),
  ]);
  return orphans;
}
