/**
 * Permission assertions.
 *
 * The bug this file exists to catch is the one that only shows up when someone
 * abuses it: a co-host who can kick the host, a guest who can seek the video, a
 * member who can end the room. Every one of those is a single wrong comparison,
 * so the matrix is asserted explicitly rather than derived from the same tables
 * the production code uses.
 */
import { describe, expect, it } from 'vitest';
import { can, canActOn, canControlVideo, type Role, type RoomPolicy } from '@syncstudy/shared';
import { resolvePermissions } from '../handlers/context.js';

const ROLES: readonly Role[] = ['host', 'co_host', 'member', 'guest'];

const basePolicy: RoomPolicy = {
  playbackControl: 'everyone',
  chatLocked: false,
  slowModeSec: 0,
  waitForSlow: false,
  callEnabled: true,
  screenshareEnabled: true,
  annotationsEnabled: true,
  maxParticipants: 8,
};

describe('can()', () => {
  it('reserves room-destroying powers for the host alone', () => {
    for (const permission of ['host.end', 'host.policy', 'host.transfer', 'host.set_role', 'host.ban'] as const) {
      expect(can('host', permission), permission).toBe(true);
      expect(can('co_host', permission), permission).toBe(false);
      expect(can('member', permission), permission).toBe(false);
      expect(can('guest', permission), permission).toBe(false);
    }
  });

  it('lets co-hosts moderate but not restructure', () => {
    expect(can('co_host', 'host.kick')).toBe(true);
    expect(can('co_host', 'host.force_mute')).toBe(true);
    expect(can('co_host', 'chat.delete.any')).toBe(true);
    expect(can('co_host', 'host.ban')).toBe(false);
    expect(can('co_host', 'host.set_role')).toBe(false);
  });

  it('keeps guests read-mostly', () => {
    expect(can('guest', 'chat.send')).toBe(true);
    expect(can('guest', 'call.join')).toBe(true);
    expect(can('guest', 'notes.edit')).toBe(false);
    expect(can('guest', 'checklist.edit')).toBe(false);
    expect(can('guest', 'screenshare')).toBe(false);
    expect(can('guest', 'video.set')).toBe(false);
  });

  it('never lets a member moderate', () => {
    for (const permission of ['host.kick', 'host.ban', 'host.force_mute', 'chat.delete.any'] as const) {
      expect(can('member', permission), permission).toBe(false);
    }
  });
});

describe('canActOn()', () => {
  it('refuses to let anyone act on themselves', () => {
    for (const role of ROLES) {
      expect(canActOn(role, role), role).toBe(false);
    }
  });

  it('stops a co-host from acting on the host', () => {
    expect(canActOn('co_host', 'host')).toBe(false);
    expect(canActOn('member', 'host')).toBe(false);
    expect(canActOn('guest', 'host')).toBe(false);
  });

  it('allows action strictly downward only', () => {
    expect(canActOn('host', 'co_host')).toBe(true);
    expect(canActOn('host', 'member')).toBe(true);
    expect(canActOn('co_host', 'member')).toBe(true);
    expect(canActOn('co_host', 'guest')).toBe(true);
    expect(canActOn('member', 'guest')).toBe(true);
    expect(canActOn('member', 'co_host')).toBe(false);
    expect(canActOn('guest', 'member')).toBe(false);
  });
});

describe('canControlVideo()', () => {
  it('never lets a guest drive the room, whatever the policy', () => {
    for (const policy of ['everyone', 'host_and_cohosts', 'host_only'] as const) {
      expect(canControlVideo('guest', policy), policy).toBe(false);
    }
  });

  it('honours host_only', () => {
    expect(canControlVideo('host', 'host_only')).toBe(true);
    expect(canControlVideo('co_host', 'host_only')).toBe(false);
    expect(canControlVideo('member', 'host_only')).toBe(false);
  });

  it('honours host_and_cohosts', () => {
    expect(canControlVideo('host', 'host_and_cohosts')).toBe(true);
    expect(canControlVideo('co_host', 'host_and_cohosts')).toBe(true);
    expect(canControlVideo('member', 'host_and_cohosts')).toBe(false);
  });

  it('defaults to cooperative', () => {
    expect(canControlVideo('member', 'everyone')).toBe(true);
    expect(canControlVideo('co_host', 'everyone')).toBe(true);
  });
});

describe('resolvePermissions()', () => {
  it('reflects the playback policy, not just the role', () => {
    expect(resolvePermissions('member', basePolicy).canControlVideo).toBe(true);
    expect(
      resolvePermissions('member', { ...basePolicy, playbackControl: 'host_only' }).canControlVideo,
    ).toBe(false);
  });

  it('lets moderators speak through a chat lock, and nobody else', () => {
    const locked: RoomPolicy = { ...basePolicy, chatLocked: true };
    expect(resolvePermissions('host', locked).canSendChat).toBe(true);
    expect(resolvePermissions('co_host', locked).canSendChat).toBe(true);
    expect(resolvePermissions('member', locked).canSendChat).toBe(false);
    expect(resolvePermissions('guest', locked).canSendChat).toBe(false);
  });

  it('respects room-level switches for call and screenshare', () => {
    const off: RoomPolicy = { ...basePolicy, callEnabled: false, screenshareEnabled: false };
    expect(resolvePermissions('host', off).canJoinCall).toBe(false);
    expect(resolvePermissions('host', off).canScreenShare).toBe(false);
    expect(resolvePermissions('host', basePolicy).canJoinCall).toBe(true);
    expect(resolvePermissions('host', basePolicy).canScreenShare).toBe(true);
  });

  it('marks only moderators as able to moderate, and only the host as manager', () => {
    expect(resolvePermissions('host', basePolicy)).toMatchObject({ canModerate: true, canManageRoom: true });
    expect(resolvePermissions('co_host', basePolicy)).toMatchObject({ canModerate: true, canManageRoom: false });
    expect(resolvePermissions('member', basePolicy)).toMatchObject({ canModerate: false, canManageRoom: false });
    expect(resolvePermissions('guest', basePolicy)).toMatchObject({ canModerate: false, canManageRoom: false });
  });

  it('echoes the role back so the client never has to guess it', () => {
    for (const role of ROLES) {
      expect(resolvePermissions(role, basePolicy).role).toBe(role);
    }
  });
});
