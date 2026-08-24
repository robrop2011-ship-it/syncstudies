/**
 * The signed-in user's own record, fetched once per request.
 */
import { cache } from 'react';
import { prisma } from '@syncstudy/db';
import { toSelfView, toSettingsView, type MeView } from '@/lib/server/views';

const SELF_SELECT = {
  id: true,
  handle: true,
  displayName: true,
  avatarKey: true,
  bio: true,
  school: true,
  isMinor: true,
  isGuest: true,
  status: true,
  createdAt: true,
  settings: true,
} as const;

export const getMeRecord = cache(async (userId: string) => {
  return prisma.user.findUnique({ where: { id: userId }, select: SELF_SELECT });
});

/** Null only if the row vanished between the session check and this call. */
export const getMeView = cache(async (userId: string): Promise<MeView | null> => {
  const record = await getMeRecord(userId);
  if (record === null) return null;
  return { user: toSelfView(record), settings: toSettingsView(record.settings) };
});
