/**
 * The single permission resolver (PLAN.md §11.2).
 *
 * Every REST route and every socket handler funnels through here. There is no
 * second place where permissions are decided — if you find yourself writing
 * `if (role === 'host')` in a handler, add a Permission instead.
 */

export type Role = 'host' | 'co_host' | 'member' | 'guest';

export const ROLE_RANK: Record<Role, number> = { host: 3, co_host: 2, member: 1, guest: 0 };

export type Permission =
  | 'video.set'
  | 'chat.send'
  | 'chat.delete.any'
  | 'notes.edit'
  | 'checklist.edit'
  | 'call.join'
  | 'screenshare'
  | 'host.kick'
  | 'host.ban'
  | 'host.set_role'
  | 'host.transfer'
  | 'host.force_mute'
  | 'host.policy'
  | 'host.end';

const GRANTS: Record<Permission, readonly Role[]> = {
  'video.set': ['host', 'co_host'],
  'chat.send': ['host', 'co_host', 'member', 'guest'],
  'chat.delete.any': ['host', 'co_host'],
  'notes.edit': ['host', 'co_host', 'member'],
  'checklist.edit': ['host', 'co_host', 'member'],
  'call.join': ['host', 'co_host', 'member', 'guest'],
  screenshare: ['host', 'co_host', 'member'],
  'host.kick': ['host', 'co_host'],
  'host.ban': ['host'],
  'host.set_role': ['host'],
  'host.transfer': ['host'],
  'host.force_mute': ['host', 'co_host'],
  'host.policy': ['host'],
  'host.end': ['host'],
};

export function can(role: Role, permission: Permission): boolean {
  return GRANTS[permission].includes(role);
}

/**
 * A moderator may only act on someone strictly below them, and never on themselves.
 * Without this, a co-host can kick the host.
 */
export function canActOn(actorRole: Role, targetRole: Role): boolean {
  return ROLE_RANK[actorRole] > ROLE_RANK[targetRole];
}

/** Everything the client needs to render affordances, computed once server-side. */
export interface ResolvedPermissions {
  role: Role;
  canControlVideo: boolean;
  canSetVideo: boolean;
  canSendChat: boolean;
  canDeleteAnyMessage: boolean;
  canEditNotes: boolean;
  canEditChecklist: boolean;
  canJoinCall: boolean;
  canScreenShare: boolean;
  canModerate: boolean;
  canManageRoom: boolean;
}
