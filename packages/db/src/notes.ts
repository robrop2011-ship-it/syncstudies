/**
 * `note_items` and `checklist_items` row → view mappings, in one place.
 *
 * Same reasoning as `messages.ts`: both services read these tables — the
 * realtime service builds the room snapshot, the web app serves the session
 * export — and two mappings are two chances for them to disagree about what a
 * resolved question or a completed checklist item looks like.
 */
import type { ChecklistItemView, NoteItemView, PublicUser } from '@syncstudy/shared';
import { Prisma } from '@prisma/client';
import type { ResolveAvatarUrl } from './messages';

const USER_SELECT = { id: true, handle: true, displayName: true, avatarKey: true } as const;

export const NOTE_ITEM_SELECT = {
  id: true,
  kind: true,
  body: true,
  videoRef: true,
  videoTs: true,
  resolvedAt: true,
  createdAt: true,
  author: { select: USER_SELECT },
} satisfies Prisma.NoteItemSelect;

export const CHECKLIST_SELECT = {
  id: true,
  label: true,
  position: true,
  videoTs: true,
  completedAt: true,
  creator: { select: USER_SELECT },
  completer: { select: USER_SELECT },
} satisfies Prisma.ChecklistItemSelect;

export type NoteItemRow = Prisma.NoteItemGetPayload<{ select: typeof NOTE_ITEM_SELECT }>;
export type ChecklistRow = Prisma.ChecklistItemGetPayload<{ select: typeof CHECKLIST_SELECT }>;

type UserRow = { id: string; handle: string; displayName: string; avatarKey: string | null };

const passThrough: ResolveAvatarUrl = (key) => key;

function toPublicUser(row: UserRow | null, resolveAvatarUrl: ResolveAvatarUrl): PublicUser | null {
  if (row === null) return null;
  return {
    id: row.id,
    handle: row.handle,
    displayName: row.displayName,
    avatarUrl: resolveAvatarUrl(row.avatarKey),
  };
}

/** `kind` is a varchar in the database; the union is the contract. */
function asNoteKind(value: string): NoteItemView['kind'] {
  return value === 'question' || value === 'bookmark' ? value : 'note';
}

export function toNoteItemView(
  row: NoteItemRow,
  resolveAvatarUrl: ResolveAvatarUrl = passThrough,
): NoteItemView {
  return {
    id: row.id,
    kind: asNoteKind(row.kind),
    author: toPublicUser(row.author, resolveAvatarUrl),
    body: row.body,
    videoRef: row.videoRef,
    videoTs: row.videoTs,
    resolvedAt: row.resolvedAt === null ? null : row.resolvedAt.getTime(),
    createdAt: row.createdAt.getTime(),
  };
}

export function toChecklistItemView(
  row: ChecklistRow,
  resolveAvatarUrl: ResolveAvatarUrl = passThrough,
): ChecklistItemView {
  return {
    id: row.id,
    label: row.label,
    position: row.position,
    createdBy: toPublicUser(row.creator, resolveAvatarUrl),
    // §3.6 S6: who ticked it is part of the feature, not decoration — a shared
    // checklist with anonymous completions is a checklist nobody trusts.
    completedAt: row.completedAt === null ? null : row.completedAt.getTime(),
    completedBy: row.completedAt === null ? null : toPublicUser(row.completer, resolveAvatarUrl),
    videoTs: row.videoTs,
  };
}
