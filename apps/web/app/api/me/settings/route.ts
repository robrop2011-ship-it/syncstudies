/**
 * PATCH /api/me/settings — PLAN.md §10.1, §11.9.
 *
 * The interesting part is the minor lock. `is_minor` accounts have four settings
 * that are not theirs to change (§11.9), and this route is where that is
 * enforced — the settings page disables the controls, but a disabled control is
 * a suggestion, not a boundary.
 *
 * The refusal is explicit rather than silent. Quietly ignoring the change would
 * leave a UI that appears to have accepted it, which is worse than being told no.
 */
import type { NextRequest } from 'next/server';
import { prisma } from '@syncstudy/db';
import { Schemas } from '@syncstudy/shared';
import { apiHandler, fail, ok } from '@/lib/server/respond';
import { readJson, requireSameOrigin } from '@/lib/server/request';
import { limitOr429 } from '@/lib/server/rate-limit';
import { requireApiSession } from '@/lib/server/session';
import { MINOR_LOCKED_SETTINGS, toSettingsView, type SettingsView } from '@/lib/server/views';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface SettingsWrite {
  profileVisibility?: string;
  showOnlineStatus?: boolean;
  theme?: string;
  joinMuted?: boolean;
  joinCameraOff?: boolean;
  pushToTalk?: boolean;
  reduceMotion?: boolean;
  hideIpFromPeers?: boolean;
  defaultRoomPrivacy?: string;
}

export const PATCH = apiHandler(async (req: NextRequest) => {
  requireSameOrigin(req);

  const { session } = await requireApiSession();
  const limited = limitOr429('me:update:user', session.user.id);
  if (limited !== null) return limited;

  const input = Schemas.UpdateSettingsInput.parse(await readJson(req));

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, isMinor: true },
  });
  if (user === null) return fail('unauthorized', 'Sign in to continue.');

  if (user.isMinor) {
    const blocked: string[] = [];
    if (input.profileVisibility !== undefined && input.profileVisibility !== MINOR_LOCKED_SETTINGS.profileVisibility) {
      blocked.push('profile visibility');
    }
    if (input.showOnlineStatus !== undefined && input.showOnlineStatus !== MINOR_LOCKED_SETTINGS.showOnlineStatus) {
      blocked.push('online status');
    }
    if (input.hideIpFromPeers !== undefined && input.hideIpFromPeers !== MINOR_LOCKED_SETTINGS.hideIpFromPeers) {
      blocked.push('hiding your IP address in calls');
    }
    if (blocked.length > 0) {
      return fail(
        'forbidden',
        `On an account for under-18s, ${blocked.join(' and ')} stays as it is. Everything else on this page is yours to change.`,
      );
    }
  }

  const data: SettingsWrite = {};
  if (input.profileVisibility !== undefined) data.profileVisibility = input.profileVisibility;
  if (input.showOnlineStatus !== undefined) data.showOnlineStatus = input.showOnlineStatus;
  if (input.theme !== undefined) data.theme = input.theme;
  if (input.joinMuted !== undefined) data.joinMuted = input.joinMuted;
  if (input.joinCameraOff !== undefined) data.joinCameraOff = input.joinCameraOff;
  if (input.pushToTalk !== undefined) data.pushToTalk = input.pushToTalk;
  if (input.reduceMotion !== undefined) data.reduceMotion = input.reduceMotion;
  if (input.hideIpFromPeers !== undefined) data.hideIpFromPeers = input.hideIpFromPeers;

  if (user.isMinor) {
    // Re-asserted on every write, so a row that drifted (an older account that
    // was migrated, a bug in a future route) heals itself here.
    data.profileVisibility = MINOR_LOCKED_SETTINGS.profileVisibility;
    data.showOnlineStatus = MINOR_LOCKED_SETTINGS.showOnlineStatus;
    data.hideIpFromPeers = MINOR_LOCKED_SETTINGS.hideIpFromPeers;
    data.defaultRoomPrivacy = MINOR_LOCKED_SETTINGS.defaultRoomPrivacy;
  }

  // Upsert rather than update: the settings row is created with the account, but
  // a PATCH is not the place to discover that an old row is missing.
  const settings = await prisma.userSettings.upsert({
    where: { userId: user.id },
    update: data,
    create: { userId: user.id, ...data },
  });

  const body: SettingsView = toSettingsView(settings);
  return ok(body);
});
