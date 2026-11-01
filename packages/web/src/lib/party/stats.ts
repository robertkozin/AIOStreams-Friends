/* eslint-disable lingui/no-unlocalized-strings -- debug statistics, English only, to keep the locale files untouched */
import type { GroupCommand } from '@aiostreams/core';
import type { PlayerController } from '../playback/controller';
import { settings } from '../settings';
import { monotonic } from './clock';
import type { Invite } from './invite';
import { party, positionAt, relayHost, type PartyState } from './party';
import { partyFollower, type Follower } from './playback';

/*
 * The watch party's page of the player's statistics. It reads the party's
 * public state, and the follower's own fields, which are private to
 * TypeScript only; one renamed upstream shows as "?".
 */

export const PARTY_STATS_PAGE = { id: 'party', label: 'Watch party' };

/** Drift measured over this long shows as a range. */
const DRIFT_HISTORY_MS = 30_000;

interface FollowerFields {
  player: () => PlayerController;
  speed: unknown;
  rate: number;
  seekLead: number;
  settleUntil: number;
  lastSeekAt: number;
  awaitingReady: boolean;
  pauseAt: number | null;
  reported: string;
}

/** What is seen of the party from here, since the party or the follower last changed. */
const seen = {
  invite: null as Invite | null,
  reconnects: 0,
  live: false,
  command: null as {
    command: GroupCommand;
    earlyMs: number;
    at: number;
  } | null,
  follower: null as Follower | null,
  drifts: [] as { driftMs: number; at: number }[],
  seeks: 0,
  lastSeekAt: -Infinity,
  speedChanges: 0,
  rate: 1,
};

party.subscribe(() => {
  const state = party.state();
  if (state?.invite !== seen.invite) {
    seen.invite = state?.invite ?? null;
    seen.reconnects = 0;
    seen.command = null;
  }
  if (seen.live && state?.status === 'reconnecting') seen.reconnects++;
  seen.live = state?.status === 'live';
});

party.on((event) => {
  if (event.type !== 'command') return;
  const clock = party.clock();
  seen.command = {
    command: event.command,
    earlyMs: clock ? event.command.when - clock.now() : 0,
    at: monotonic(),
  };
});

const signed = (ms: number) =>
  `${ms > 0 ? '+' : ms < 0 ? '−' : '±'}${Math.abs(Math.round(ms))} ms`;
const seconds = (ms: number) => `${(ms / 1000).toFixed(2)} s`;
const ago = (ms: number) =>
  ms < 1_000 ? `${Math.round(ms)} ms ago` : `${(ms / 1000).toFixed(1)} s ago`;
/** Drift, ahead of the group positive. */
const drift = (ms: number) =>
  `${signed(ms)} ${ms > 0 ? 'ahead' : ms < 0 ? 'behind' : ''}`.trimEnd();

export const followsParty = (): boolean => partyFollower() !== null;

/** The follower's drift now, noting its seeks and changes of speed since the last look. */
function sample(follower: Follower) {
  const fields = follower as unknown as Partial<FollowerFields>;
  const now = performance.now();
  if (seen.follower !== follower) {
    Object.assign(seen, {
      follower,
      drifts: [],
      seeks: 0,
      lastSeekAt: fields.lastSeekAt ?? -Infinity,
      speedChanges: 0,
      rate: fields.rate ?? 1,
    });
  }
  if (
    fields.lastSeekAt !== undefined &&
    fields.lastSeekAt !== seen.lastSeekAt
  ) {
    seen.lastSeekAt = fields.lastSeekAt;
    seen.seeks++;
  }
  if (fields.rate !== undefined && fields.rate !== seen.rate) {
    if (fields.rate !== 1) seen.speedChanges++;
    seen.rate = fields.rate;
  }
  const state = party.state();
  const timeline =
    state?.timeline?.playlistItemId === follower.playlistItemId
      ? state.timeline
      : null;
  const clock = party.clock();
  const positionMs = follower.position();
  const expectedMs =
    timeline && positionAt(timeline, clock ? clock.now() : Date.now());
  const driftMs =
    expectedMs !== null && timeline?.playing ? positionMs - expectedMs : null;
  seen.drifts = seen.drifts.filter((d) => now - d.at < DRIFT_HISTORY_MS);
  if (driftMs !== null) seen.drifts.push({ driftMs, at: now });
  return { fields, now, positionMs, expectedMs, driftMs };
}

function connectionLines(state: PartyState): string[] {
  const lines = [
    `Relay: ${relayHost(state.invite.relay)}, ${state.status}` +
      (seen.reconnects ? `, reconnected ${seen.reconnects}×` : ''),
  ];
  const clock = party.clock();
  lines.push(
    `Clock: ${
      clock?.synced
        ? `${signed(clock.now() - Date.now())} from this device, round trip ${Math.round(clock.rtt)} ms`
        : "not synced, on this device's clock"
    }`
  );
  const last = seen.command;
  if (last) {
    const { command, earlyMs } = last;
    const timing =
      earlyMs >= 0
        ? `came ${Math.round(earlyMs)} ms early`
        : `came ${Math.round(-earlyMs)} ms late`;
    lines.push(
      `Last command: ${command.command} at ${seconds(command.positionMs)}, ${timing}, ${ago(monotonic() - last.at)}`
    );
  }
  return lines;
}

function fixedSpeed(fields: Partial<FollowerFields>): string | null {
  if (!fields.speed) return "this player can't change speed";
  if (!settings.party.speedSync.read())
    return 'speed changes are off in settings';
  return fields.player?.().state.passthrough
    ? 'the sound is passed through'
    : null;
}

function speedLine(fields: Partial<FollowerFields>): string {
  const { rate } = fields;
  if (rate === undefined) return 'Speed: ?';
  const fixed = fixedSpeed(fields);
  if (fixed) return `Speed: ${rate}×, fixed: ${fixed}`;
  if (rate === 1) return 'Speed: 1×';
  return `Speed: ${rate}×, ${rate > 1 ? 'catching up' : 'letting the group catch up'}`;
}

function syncLines(follower: Follower): string[] {
  const { fields, now, positionMs, expectedMs, driftMs } = sample(follower);
  const lines = [
    `Position: ${seconds(positionMs)}, ` +
      (expectedMs === null
        ? 'no timeline for this item'
        : `group at ${seconds(expectedMs)}`),
  ];
  if (driftMs !== null) lines.push(`Drift: ${drift(driftMs)}`);
  const drifts = seen.drifts.map((d) => d.driftMs);
  if (drifts.length > 1) {
    const mean = drifts.reduce((a, b) => a + b, 0) / drifts.length;
    lines.push(
      `Drift, 30 s: ${signed(Math.min(...drifts))} to ${signed(Math.max(...drifts))}, average ${signed(mean)}`
    );
  }
  lines.push(speedLine(fields));
  lines.push(
    `Since stats opened: ${seen.seeks} seeks, ${seen.speedChanges} speed changes`
  );
  const { seekLead, lastSeekAt } = fields;
  lines.push(
    `Seeks: lead ${seekLead === undefined ? '?' : `${seekLead} ms`}` +
      (lastSeekAt !== undefined && Number.isFinite(lastSeekAt)
        ? `, last ${ago(now - lastSeekAt)}`
        : '')
  );
  const flags = [
    fields.settleUntil !== undefined &&
      now < fields.settleUntil &&
      'settling after a seek',
    fields.awaitingReady && 'waiting to report ready',
    typeof fields.pauseAt === 'number' &&
      `playing on to the pause at ${seconds(fields.pauseAt)}`,
  ].filter(Boolean);
  lines.push(
    `Follower: ${[`reported ${fields.reported ?? '?'}`, ...flags].join(', ')}`
  );
  return lines;
}

function partyLines(state: PartyState): string[] {
  const lines = [`Party: group ${state.group}`];
  const locks = [
    state.lock.control && 'host controls',
    state.lock.joins && 'no joins',
  ].filter(Boolean);
  if (locks.length) lines.push(`Lock: ${locks.join(', ')}`);
  for (const m of state.members) {
    // The relay hears how far behind each member is.
    const notes = [
      m.host && 'host',
      m.you && 'you',
      m.away && 'away',
      m.buffering && 'buffering',
      m.offsetMs !== undefined && drift(-m.offsetMs),
    ].filter(Boolean);
    lines.push(`${m.name}: ${notes.length ? notes.join(', ') : 'in step'}`);
  }
  return lines;
}

/** The party's page of a player's statistics. */
export function partyStatsText(): string {
  const follower = partyFollower();
  const state = party.state();
  if (!follower || !state) return 'Not following a watch party';
  return [
    ...connectionLines(state),
    ...syncLines(follower),
    ...partyLines(state),
  ].join('\n');
}

/** Where the player following the party is against it; null when none does. */
export function partyDriftLine(): string | null {
  const follower = partyFollower();
  if (!follower) return null;
  const { driftMs } = sample(follower);
  return `Watch party: ${driftMs === null ? 'following' : drift(driftMs)}`;
}
