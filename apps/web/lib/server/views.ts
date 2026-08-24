/**
 * Row → wire shapes.
 *
 * One place decides what leaves the server about a user, so `passwordHash`,
 * `recoveryHash` and `ipHash` cannot leak by someone forgetting a `select`.
 */

export type ProfileVisibility = 'public' | 'rooms_only' | 'private';
export type ThemePreference = 'system' | 'light' | 'dark';
export type RoomPrivacy = 'private' | 'unlisted';

export interface SelfView {
  id: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
  school: string | null;
  isMinor: boolean;
  isGuest: boolean;
  status: string;
  createdAt: string;
}

export interface SettingsView {
  profileVisibility: ProfileVisibility;
  showOnlineStatus: boolean;
  defaultRoomPrivacy: RoomPrivacy;
  theme: ThemePreference;
  joinMuted: boolean;
  joinCameraOff: boolean;
  pushToTalk: boolean;
  reduceMotion: boolean;
  hideIpFromPeers: boolean;
}

export interface MeView {
  user: SelfView;
  settings: SettingsView;
}

/**
 * Non-negotiable protections for accounts flagged `is_minor` (PLAN.md §11.9).
 * Applied at signup and re-asserted on every settings write — a client that
 * hand-crafts a PATCH must not be able to turn these off.
 */
export const MINOR_LOCKED_SETTINGS = {
  profileVisibility: 'private',
  defaultRoomPrivacy: 'private',
  showOnlineStatus: false,
  hideIpFromPeers: true,
} as const;

export const DEFAULT_SETTINGS: SettingsView = {
  profileVisibility: 'rooms_only',
  showOnlineStatus: true,
  defaultRoomPrivacy: 'private',
  theme: 'system',
  joinMuted: true,
  joinCameraOff: true,
  pushToTalk: false,
  reduceMotion: false,
  hideIpFromPeers: false,
};

export interface UserRecordLike {
  id: string;
  handle: string;
  displayName: string;
  avatarKey: string | null;
  bio: string | null;
  school: string | null;
  isMinor: boolean;
  isGuest: boolean;
  status: string;
  createdAt: Date;
}

export interface SettingsRecordLike {
  profileVisibility: string;
  showOnlineStatus: boolean;
  defaultRoomPrivacy: string;
  theme: string;
  joinMuted: boolean;
  joinCameraOff: boolean;
  pushToTalk: boolean;
  reduceMotion: boolean;
  hideIpFromPeers: boolean;
}

/**
 * Avatars are served from a dedicated domain, never the app origin (§11.8).
 * With no domain configured there is no URL, and the UI falls back to the
 * deterministic generated avatar — which is also the default for everyone who
 * never uploaded one.
 */
export function avatarUrlFor(avatarKey: string | null): string | null {
  if (avatarKey === null || avatarKey.length === 0) return null;
  const base = process.env.NEXT_PUBLIC_AVATAR_BASE_URL;
  if (base === undefined || base.length === 0) return null;
  return `${base.replace(/\/+$/, '')}/${avatarKey}`;
}

export function toSelfView(user: UserRecordLike): SelfView {
  return {
    id: user.id,
    handle: user.handle,
    displayName: user.displayName,
    avatarUrl: avatarUrlFor(user.avatarKey),
    bio: user.bio,
    school: user.school,
    isMinor: user.isMinor,
    isGuest: user.isGuest,
    status: user.status,
    createdAt: user.createdAt.toISOString(),
  };
}

function asProfileVisibility(value: string): ProfileVisibility {
  return value === 'public' || value === 'private' || value === 'rooms_only' ? value : 'rooms_only';
}

function asTheme(value: string): ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
}

function asRoomPrivacy(value: string): RoomPrivacy {
  return value === 'unlisted' ? 'unlisted' : 'private';
}

/**
 * The settings row is created with the account, so a null here means something
 * went wrong upstream rather than "no preferences". Returning the documented
 * defaults keeps a page render from failing over it; the safe defaults are the
 * conservative ones either way.
 */
export function toSettingsView(settings: SettingsRecordLike | null): SettingsView {
  if (settings === null) return { ...DEFAULT_SETTINGS };
  return {
    profileVisibility: asProfileVisibility(settings.profileVisibility),
    showOnlineStatus: settings.showOnlineStatus,
    defaultRoomPrivacy: asRoomPrivacy(settings.defaultRoomPrivacy),
    theme: asTheme(settings.theme),
    joinMuted: settings.joinMuted,
    joinCameraOff: settings.joinCameraOff,
    pushToTalk: settings.pushToTalk,
    reduceMotion: settings.reduceMotion,
    hideIpFromPeers: settings.hideIpFromPeers,
  };
}
