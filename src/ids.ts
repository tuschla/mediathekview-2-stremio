/**
 * Item IDs: `mediathek:` + base64url(JSON). The API cannot look films up by ID, so an ID carries the
 * query that finds its films again. decodeId() accepts only the shapes encodeId() produces.
 */
import { showSource, type ShowRef } from './model.ts';

export const ID_PREFIX = 'mediathek:';
/** Longer than any MediathekView title or topic. */
const MAX_TEXT_LENGTH = 300;

export type ItemId =
  | ({ kind: 'show' } & ShowRef)
  | ({ kind: 'episode'; key: string } & ShowRef)
  | { kind: 'movie'; channel: string; topic: string; timestamp: number; baseTitle: string };

export function encodeId(id: ItemId): string {
  return ID_PREFIX + Buffer.from(JSON.stringify(id)).toString('base64url');
}

export function decodeId(raw: string): ItemId | undefined {
  if (!raw.startsWith(ID_PREFIX)) return undefined;
  try {
    const value: unknown = JSON.parse(Buffer.from(raw.slice(ID_PREFIX.length), 'base64url').toString('utf8'));
    return isItemId(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isText(value: unknown, maxLength = MAX_TEXT_LENGTH): value is string {
  return typeof value === 'string' && value !== '' && value.length <= maxLength;
}

function isItemId(value: unknown): value is ItemId {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.channel !== 'string') return false;
  const isShowRef = v.source === showSource(v.channel) && isText(v.name);
  switch (v.kind) {
    case 'show':
      return isShowRef;
    case 'episode':
      return isShowRef && isText(v.key, 2 * MAX_TEXT_LENGTH);
    case 'movie':
      return (v.topic === '' || isText(v.topic)) && Number.isInteger(v.timestamp) && isText(v.baseTitle);
    default:
      return false;
  }
}
