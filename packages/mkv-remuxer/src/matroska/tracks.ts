import {
  childElements,
  readBigUint,
  readBytes,
  readFloat,
  readString,
  readUint,
  type EbmlElement,
} from './ebml.js';
import { Id } from './ids.js';

export type TrackKind = 'video' | 'audio' | 'subtitle';

/** A Dolby Vision configuration record's fields that playlists need. */
export type DolbyVision = {
  profile: number;
  level: number;
  /** What a player without Dolby Vision sees: 1 HDR10, 2 SDR, 4 HLG, 0 nothing. */
  compatibility: number;
};

export type MkvTrack = {
  number: number;
  uid: string;
  kind: TrackKind;
  codecId: string;
  codecPrivate?: string | undefined;
  name?: string | undefined;
  language: string;
  isDefault: boolean;
  isForced: boolean;
  isEnabled: boolean;
  defaultDurationNs?: number | undefined;
  width?: number | undefined;
  height?: number | undefined;
  transferCharacteristics?: number | undefined;
  dolbyVision?: DolbyVision | undefined;
  sampleRate?: number | undefined;
  channels?: number | undefined;
  // The TrackEntry element verbatim, base64. Lets a rebuilt header carry the
  // track through byte for byte.
  entry: string;
};

// Matroska TrackType values. Anything else (logo, buttons, control) is dropped.
const TRACK_KINDS: Record<number, TrackKind> = {
  1: 'video',
  2: 'audio',
  17: 'subtitle',
};

export function parseTracks(buf: Uint8Array, tracks: EbmlElement): MkvTrack[] {
  const result: MkvTrack[] = [];
  for (const el of childElements(buf, tracks.dataStart, tracks.dataEnd)) {
    if (el.id !== Id.TrackEntry) {
      continue;
    }
    const track = parseTrackEntry(buf, el);
    if (track) {
      result.push(track);
    }
  }
  return result;
}

function parseTrackEntry(buf: Uint8Array, entry: EbmlElement): MkvTrack | null {
  const track: MkvTrack = {
    number: 0,
    uid: '',
    kind: 'video',
    codecId: '',
    language: 'eng',
    isDefault: true,
    isForced: false,
    isEnabled: true,
    entry: Buffer.from(buf.subarray(entry.start, entry.dataEnd)).toString(
      'base64',
    ),
  };
  let type = 0;
  let bcp47: string | undefined;

  for (const el of childElements(buf, entry.dataStart, entry.dataEnd)) {
    switch (el.id) {
      case Id.TrackNumber:
        track.number = readUint(buf, el);
        break;
      case Id.TrackUID:
        track.uid = readBigUint(buf, el);
        break;
      case Id.TrackType:
        type = readUint(buf, el);
        break;
      case Id.CodecID:
        track.codecId = readString(buf, el);
        break;
      case Id.CodecPrivate:
        track.codecPrivate = readBytes(buf, el).toString('base64');
        break;
      case Id.Name:
        track.name = readString(buf, el) || undefined;
        break;
      case Id.Language:
        track.language = readString(buf, el) || 'und';
        break;
      // BCP 47 wins over the older three-letter Language element when
      // both are present.
      case Id.LanguageBCP47:
        bcp47 = readString(buf, el) || undefined;
        break;
      case Id.FlagDefault:
        track.isDefault = readUint(buf, el) === 1;
        break;
      case Id.FlagForced:
        track.isForced = readUint(buf, el) === 1;
        break;
      case Id.FlagEnabled:
        track.isEnabled = readUint(buf, el) === 1;
        break;
      case Id.DefaultDuration:
        track.defaultDurationNs = readUint(buf, el);
        break;
      case Id.Video:
        for (const v of childElements(buf, el.dataStart, el.dataEnd)) {
          if (v.id === Id.PixelWidth) {
            track.width = readUint(buf, v);
          }
          if (v.id === Id.PixelHeight) {
            track.height = readUint(buf, v);
          }
          if (v.id === Id.Colour) {
            const transfer = [
              ...childElements(buf, v.dataStart, v.dataEnd),
            ].find((c) => c.id === Id.TransferCharacteristics);
            track.transferCharacteristics = transfer
              ? readUint(buf, transfer)
              : undefined;
          }
        }
        break;
      case Id.BlockAdditionMapping:
        track.dolbyVision ??= parseDolbyVision(buf, el);
        break;
      case Id.Audio:
        // Matroska defaults for an Audio element that omits them.
        track.sampleRate = 8000;
        track.channels = 1;
        for (const a of childElements(buf, el.dataStart, el.dataEnd)) {
          if (a.id === Id.SamplingFrequency) {
            track.sampleRate = readFloat(buf, a);
          }
          if (a.id === Id.Channels) {
            track.channels = readUint(buf, a);
          }
        }
        break;
    }
  }

  const kind = TRACK_KINDS[type];
  if (!kind || !track.number || !track.codecId) {
    return null;
  }

  track.kind = kind;
  if (bcp47) {
    track.language = bcp47;
  }
  return track;
}

// BlockAddIDType names the record by its ISO BMFF box: dvcC up to profile 7,
// dvvC above.
const DOLBY_VISION_TYPES = new Set(['dvcC', 'dvvC']);

function parseDolbyVision(
  buf: Uint8Array,
  mapping: EbmlElement,
): DolbyVision | undefined {
  let type = '';
  let record: Buffer | undefined;
  for (const el of childElements(buf, mapping.dataStart, mapping.dataEnd)) {
    if (el.id === Id.BlockAddIDType) {
      const value = readUint(buf, el);
      type = String.fromCharCode(
        (value >>> 24) & 0xff,
        (value >>> 16) & 0xff,
        (value >>> 8) & 0xff,
        value & 0xff,
      );
    }
    if (el.id === Id.BlockAddIDExtraData) {
      record = readBytes(buf, el);
    }
  }
  if (!DOLBY_VISION_TYPES.has(type) || !record || record.length < 5) {
    return undefined;
  }
  // Two version bytes, then 7 bits of profile and 6 of level, three
  // presence flags, and 4 bits of base layer compatibility.
  const bits = record.readUInt16BE(2);
  return {
    profile: bits >> 9,
    level: (bits >> 3) & 0x3f,
    compatibility: record[4]! >> 4,
  };
}
