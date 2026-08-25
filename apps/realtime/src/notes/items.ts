/**
 * Timestamped notes/questions/bookmarks and the shared checklist
 * (PLAN.md §3.6 S3, S4, S6).
 *
 * These are written to Postgres **synchronously**, unlike the notes document
 * and unlike chat. The reason is the ack: `notes:item_create` answers with the
 * created row, and a write-behind ack would be a promise rather than a fact —
 * the client would render an item that a failed INSERT then deleted out from
 * under it. Their rate limits (20–40/min, §10.2) put them nowhere near the
 * volume that made write-behind necessary for chat.
 *
 * Ordering is a **fractional index** (§3.6 S6): reordering is one UPDATE, never
 * a renumbering pass over the list.
 */
import {
  CHECKLIST_SELECT,
  NOTE_ITEM_SELECT,
  prisma,
  toChecklistItemView,
  toNoteItemView,
} from '@syncstudy/db';
import { uuidv7, type ChecklistItemView, type NoteItemView } from '@syncstudy/shared';

export async function listNoteItems(roomId: string): Promise<NoteItemView[]> {
  const rows = await prisma.noteItem.findMany({
    where: { roomId },
    select: NOTE_ITEM_SELECT,
    // Timestamped items are read against the scrubber, so video order is the
    // useful order. Items with no timestamp sort last, in creation order.
    orderBy: [{ videoTs: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
    take: 500,
  });
  return rows.map((row) => toNoteItemView(row));
}

export async function listChecklist(roomId: string): Promise<ChecklistItemView[]> {
  const rows = await prisma.checklistItem.findMany({
    where: { roomId },
    select: CHECKLIST_SELECT,
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    take: 500,
  });
  return rows.map((row) => toChecklistItemView(row));
}

export async function createNoteItem(input: {
  roomId: string;
  userId: string;
  kind: 'note' | 'question' | 'bookmark';
  body: string;
  videoRef: string | null;
  videoTs: number | null;
}): Promise<NoteItemView> {
  const row = await prisma.noteItem.create({
    data: {
      id: uuidv7(),
      roomId: input.roomId,
      userId: input.userId,
      kind: input.kind,
      body: input.body,
      videoRef: input.videoRef,
      videoTs: input.videoTs,
    },
    select: NOTE_ITEM_SELECT,
  });
  return toNoteItemView(row);
}

/** The row plus its author id, so a handler can check "may I act on this?". */
export async function findNoteItem(
  roomId: string,
  id: string,
): Promise<{ view: NoteItemView; authorId: string | null } | null> {
  const row = await prisma.noteItem.findFirst({
    where: { id, roomId },
    select: { ...NOTE_ITEM_SELECT, userId: true },
  });
  if (row === null) return null;
  return { view: toNoteItemView(row), authorId: row.userId };
}

export async function updateNoteItem(input: {
  roomId: string;
  id: string;
  userId: string;
  body?: string | undefined;
  resolved?: boolean | undefined;
}): Promise<NoteItemView | null> {
  const data: {
    body?: string;
    resolvedAt?: Date | null;
    resolvedBy?: string | null;
  } = {};
  if (input.body !== undefined) data.body = input.body;
  if (input.resolved !== undefined) {
    data.resolvedAt = input.resolved ? new Date() : null;
    data.resolvedBy = input.resolved ? input.userId : null;
  }
  if (Object.keys(data).length === 0) return null;

  // `updateMany` scoped by roomId, so a well-formed id from another room
  // updates nothing rather than reaching across the boundary (§11.2 IDOR).
  const updated = await prisma.noteItem.updateMany({
    where: { id: input.id, roomId: input.roomId },
    data,
  });
  if (updated.count === 0) return null;

  const row = await prisma.noteItem.findUnique({ where: { id: input.id }, select: NOTE_ITEM_SELECT });
  return row === null ? null : toNoteItemView(row);
}

export async function deleteNoteItem(roomId: string, id: string): Promise<boolean> {
  const deleted = await prisma.noteItem.deleteMany({ where: { id, roomId } });
  return deleted.count > 0;
}

// ── checklist ───────────────────────────────────────────────────────────────

export async function createChecklistItem(input: {
  roomId: string;
  userId: string;
  label: string;
  videoTs: number | null;
}): Promise<ChecklistItemView> {
  const last = await prisma.checklistItem.findFirst({
    where: { roomId: input.roomId },
    orderBy: { position: 'desc' },
    select: { position: true },
  });
  const row = await prisma.checklistItem.create({
    data: {
      id: uuidv7(),
      roomId: input.roomId,
      label: input.label,
      position: (last?.position ?? 0) + 1,
      createdBy: input.userId,
      videoTs: input.videoTs,
    },
    select: CHECKLIST_SELECT,
  });
  return toChecklistItemView(row);
}

/**
 * Toggle completion, recording who did it.
 *
 * Idempotent by construction: two clients ticking the same item in the same
 * moment converge, because the write sets an absolute state rather than
 * flipping one. Whoever's write lands second is recorded as the completer,
 * which is arbitrary but consistent — and both clients then see the same name.
 */
export async function toggleChecklistItem(input: {
  roomId: string;
  id: string;
  userId: string;
  completed: boolean;
}): Promise<ChecklistItemView | null> {
  const updated = await prisma.checklistItem.updateMany({
    where: { id: input.id, roomId: input.roomId },
    data: {
      completedAt: input.completed ? new Date() : null,
      completedBy: input.completed ? input.userId : null,
    },
  });
  if (updated.count === 0) return null;
  const row = await prisma.checklistItem.findUnique({
    where: { id: input.id },
    select: CHECKLIST_SELECT,
  });
  return row === null ? null : toChecklistItemView(row);
}

export async function reorderChecklistItem(
  roomId: string,
  id: string,
  position: number,
): Promise<ChecklistItemView | null> {
  const updated = await prisma.checklistItem.updateMany({ where: { id, roomId }, data: { position } });
  if (updated.count === 0) return null;
  const row = await prisma.checklistItem.findUnique({ where: { id }, select: CHECKLIST_SELECT });
  return row === null ? null : toChecklistItemView(row);
}

export async function findChecklistItem(
  roomId: string,
  id: string,
): Promise<{ createdBy: string | null } | null> {
  return prisma.checklistItem.findFirst({ where: { id, roomId }, select: { createdBy: true } });
}

export async function deleteChecklistItem(roomId: string, id: string): Promise<boolean> {
  const deleted = await prisma.checklistItem.deleteMany({ where: { id, roomId } });
  return deleted.count > 0;
}
