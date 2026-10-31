import { createLogger } from '../logging/logger.js';

const logger = createLogger('streams');

/**
 * Who is watching a stream, as the Jellyfin server knows them. A stream
 * session only knows the AIOStreams user its token was minted for; every
 * persona of a configuration shares that, so the persona comes from here.
 */
export interface StreamViewer {
  /** The configuration. */
  uuid: string;
  alias?: string;
  /** Absent for the configuration's own (primary) user. */
  personaId?: string;
  persona: string;
  client?: string;
  device?: string;
  /** What they asked to play, e.g. `Severance S02E03`. */
  title?: string;
}

/** What a Jellyfin client was handed or reported playing, and by whom. */
interface Note {
  viewer: StreamViewer;
  targetKey?: string;
  /** The NZB hash, when the URL is a playback link resolved at play time. */
  hash?: string;
  filename?: string;
  clientIp?: string;
  at: number;
}

export interface StreamViewerHint {
  targetKey?: string;
  hash?: string;
  filename?: string;
  clientIp?: string;
}

/** Progress reports refresh a note every few seconds while playing. */
const NOTE_TTL_MS = 12 * 3600_000;
const MAX_NOTES = 2000;

const notes = new Map<string, Note>();

const viewerKey = (v: StreamViewer) =>
  JSON.stringify([v.uuid, v.personaId ?? '', v.client ?? '', v.device ?? '']);

function prune(now: number): void {
  for (const [key, note] of notes) {
    if (now - note.at > NOTE_TTL_MS || notes.size > MAX_NOTES)
      notes.delete(key);
  }
}

const normFile = (f?: string) => f?.trim().toLowerCase() || undefined;

/**
 * Record that a viewer was handed, or is playing, a stream. Logged when it is
 * new for that viewer, so the log says who started what.
 */
export function noteStreamViewer(
  viewer: StreamViewer,
  hint: StreamViewerHint,
  now = Date.now()
): void {
  if (!hint.targetKey && !hint.hash && !hint.filename) return;
  const key = viewerKey(viewer);
  const previous = notes.get(key);
  const note: Note = {
    viewer,
    targetKey: hint.targetKey,
    hash: hint.hash,
    filename: normFile(hint.filename),
    clientIp: hint.clientIp,
    at: now,
  };
  notes.delete(key);
  notes.set(key, note);
  if (notes.size > MAX_NOTES) prune(now);
  const changed =
    !previous ||
    previous.targetKey !== note.targetKey ||
    previous.hash !== note.hash ||
    previous.filename !== note.filename;
  if (changed)
    logger.info(
      {
        ...viewerFields(viewer),
        targetKey: hint.targetKey,
        filename: hint.filename,
        clientIp: hint.clientIp,
      },
      `jellyfin playback: ${viewerLabel(viewer)} → ${viewer.title ?? hint.filename ?? 'unknown title'}`
    );
}

/** Flat fields for a log line, so one viewer is easy to grep for. */
export function viewerFields(v: StreamViewer) {
  return {
    configUuid: v.uuid,
    configAlias: v.alias,
    persona: v.persona,
    personaId: v.personaId,
    jfClient: v.client,
    jfDevice: v.device,
    title: v.title,
  };
}

/** `Alice (living-room · Jellyfin Web on Firefox)` */
export function viewerLabel(v: StreamViewer): string {
  const where = [v.client, v.device].filter(Boolean).join(' on ');
  const config = v.alias ?? v.uuid.slice(0, 8);
  return `${v.persona} (${config}${where ? ` · ${where}` : ''})`;
}

interface SessionLike {
  targetKey: string;
  filename?: string;
  clientIp?: string;
}

/**
 * The viewers whose notes point at a session: by target key, else by NZB hash,
 * else by filename. Only the strongest kind of match counts, and among those
 * the ones from the session's own address, when any are.
 */
export function viewersFor(
  session: SessionLike,
  now = Date.now()
): StreamViewer[] {
  const file = normFile(session.filename);
  let best = 0;
  let found: Note[] = [];
  for (const note of notes.values()) {
    if (now - note.at > NOTE_TTL_MS) continue;
    const level =
      note.targetKey && note.targetKey === session.targetKey
        ? 3
        : note.hash && session.targetKey.startsWith(`usenet:${note.hash}:`)
          ? 2
          : file && note.filename === file
            ? 1
            : 0;
    if (level === 0 || level < best) continue;
    if (level > best) {
      best = level;
      found = [];
    }
    found.push(note);
  }
  const local = session.clientIp
    ? found.filter((n) => n.clientIp === session.clientIp)
    : [];
  return (local.length ? local : found)
    .sort((a, b) => b.at - a.at)
    .map((n) => n.viewer);
}

/** A session opened: name who it is for in the log. */
export function onStreamStarted(
  session: SessionLike & { id: string; transport: string; username: string }
): void {
  const viewers = viewersFor(session);
  logger.info(
    {
      id: session.id,
      transport: session.transport,
      username: session.username,
      targetKey: session.targetKey,
      filename: session.filename,
      clientIp: session.clientIp,
      ...(viewers[0] ? viewerFields(viewers[0]) : {}),
      viewers: viewers.length > 1 ? viewers.map(viewerLabel) : undefined,
    },
    `stream started${viewers.length ? ` for ${viewers.map(viewerLabel).join(', ')}` : ''}`
  );
}

/** A session ended: name who it was for in the log. */
export function onStreamEnded(
  session: SessionLike & {
    id: string;
    username: string;
    bytesServed: number;
    startedAt: number;
  },
  reason: string
): void {
  const viewers = viewersFor(session);
  logger.info(
    {
      id: session.id,
      username: session.username,
      filename: session.filename,
      reason,
      bytesServed: session.bytesServed,
      durationMs: Date.now() - session.startedAt,
      ...(viewers[0] ? viewerFields(viewers[0]) : {}),
      viewers: viewers.length > 1 ? viewers.map(viewerLabel) : undefined,
    },
    `stream ended (${reason})${viewers.length ? ` for ${viewers.map(viewerLabel).join(', ')}` : ''}`
  );
}
