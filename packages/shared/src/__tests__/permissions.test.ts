/**
 * The permission resolver (PLAN.md §11.2).
 *
 * Every REST route and every socket handler funnels through `can()` and
 * `canActOn()`. The expected grants below are written out again by hand rather
 * than imported from the implementation: a test that re-derives the table from the
 * table it is testing proves nothing, and the failure this guards against is a
 * grant quietly widening during a refactor.
 */
import { describe, expect, it } from 'vitest';
import { ROLE_RANK, can, canActOn, type Permission, type Role } from '../permissions';
import { canControlVideo, type PlaybackControlPolicy } from '../video';

const ROLES: readonly Role[] = ['host', 'co_host', 'member', 'guest'];

const EXPECTED: Record<Permission, readonly Role[]> = {
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

describe('can', () => {
  it('matches the grant table for every role and every permission', () => {
    for (const [permission, granted] of Object.entries(EXPECTED) as [
      Permission,
      readonly Role[],
    ][]) {
      for (const role of ROLES) {
        expect(can(role, permission), role + ' → ' + permission).toBe(granted.includes(role));
      }
    }
  });

  it('gives the host everything', () => {
    for (const permission of Object.keys(EXPECTED) as Permission[]) {
      expect(can('host', permission)).toBe(true);
    }
  });

  it('keeps room ownership away from a co-host', () => {
    // A co-host moderates. Banning, changing roles, changing policy, transferring
    // ownership and ending the room stay with the one person who owns it.
    expect(can('co_host', 'host.kick')).toBe(true);
    expect(can('co_host', 'host.force_mute')).toBe(true);
    expect(can('co_host', 'host.ban')).toBe(false);
    expect(can('co_host', 'host.set_role')).toBe(false);
    expect(can('co_host', 'host.transfer')).toBe(false);
    expect(can('co_host', 'host.policy')).toBe(false);
    expect(can('co_host', 'host.end')).toBe(false);
  });

  it('lets a member participate but not moderate or change the video', () => {
    expect(can('member', 'chat.send')).toBe(true);
    expect(can('member', 'notes.edit')).toBe(true);
    expect(can('member', 'checklist.edit')).toBe(true);
    expect(can('member', 'screenshare')).toBe(true);
    expect(can('member', 'video.set')).toBe(false);
    expect(can('member', 'chat.delete.any')).toBe(false);
    expect(can('member', 'host.kick')).toBe(false);
  });

  it('limits a guest to watching, chatting and joining the call', () => {
    expect(can('guest', 'chat.send')).toBe(true);
    expect(can('guest', 'call.join')).toBe(true);
    expect(can('guest', 'notes.edit')).toBe(false);
    expect(can('guest', 'checklist.edit')).toBe(false);
    expect(can('guest', 'screenshare')).toBe(false);
    expect(can('guest', 'video.set')).toBe(false);
    expect(can('guest', 'host.kick')).toBe(false);
  });
});

describe('canActOn', () => {
  it('never lets anyone act on themselves', () => {
    // The self-kick is the classic hole: a host who kicks themselves leaves a room
    // with no host and a half-cleaned participant list.
    for (const role of ROLES) {
      expect(canActOn(role, role)).toBe(false);
    }
  });

  it('never lets a co-host act on the host', () => {
    // Without the rank comparison, `can('co_host', 'host.kick')` alone would let a
    // co-host kick the room's owner.
    expect(canActOn('co_host', 'host')).toBe(false);
    expect(canActOn('member', 'host')).toBe(false);
    expect(canActOn('guest', 'host')).toBe(false);
  });

  it('allows action strictly downward only', () => {
    expect(canActOn('host', 'co_host')).toBe(true);
    expect(canActOn('host', 'member')).toBe(true);
    expect(canActOn('host', 'guest')).toBe(true);

    expect(canActOn('co_host', 'member')).toBe(true);
    expect(canActOn('co_host', 'guest')).toBe(true);

    expect(canActOn('member', 'guest')).toBe(true);
    expect(canActOn('member', 'co_host')).toBe(false);
    expect(canActOn('guest', 'member')).toBe(false);
    expect(canActOn('guest', 'co_host')).toBe(false);
  });

  it('agrees with the rank table for all sixteen pairs', () => {
    for (const actor of ROLES) {
      for (const target of ROLES) {
        expect(canActOn(actor, target), actor + ' → ' + target).toBe(
          ROLE_RANK[actor] > ROLE_RANK[target],
        );
      }
    }
  });
});

describe('ROLE_RANK', () => {
  it('is strictly ordered host > co_host > member > guest', () => {
    expect(ROLE_RANK.host).toBeGreaterThan(ROLE_RANK.co_host);
    expect(ROLE_RANK.co_host).toBeGreaterThan(ROLE_RANK.member);
    expect(ROLE_RANK.member).toBeGreaterThan(ROLE_RANK.guest);
    expect(new Set(Object.values(ROLE_RANK)).size).toBe(ROLES.length);
  });
});

describe('canControlVideo', () => {
  const POLICIES: readonly PlaybackControlPolicy[] = [
    'everyone',
    'host_and_cohosts',
    'host_only',
  ];

  it('never lets a guest touch playback, under any policy', () => {
    // A guest is an unauthenticated visitor on a shared link. Playback control is
    // the one affordance that affects everybody at once, so it is never theirs.
    for (const policy of POLICIES) {
      expect(canControlVideo('guest', policy)).toBe(false);
    }
  });

  it('policy "everyone" means every signed-in participant', () => {
    expect(canControlVideo('host', 'everyone')).toBe(true);
    expect(canControlVideo('co_host', 'everyone')).toBe(true);
    expect(canControlVideo('member', 'everyone')).toBe(true);
    expect(canControlVideo('guest', 'everyone')).toBe(false);
  });

  it('policy "host_and_cohosts" excludes members', () => {
    expect(canControlVideo('host', 'host_and_cohosts')).toBe(true);
    expect(canControlVideo('co_host', 'host_and_cohosts')).toBe(true);
    expect(canControlVideo('member', 'host_and_cohosts')).toBe(false);
    expect(canControlVideo('guest', 'host_and_cohosts')).toBe(false);
  });

  it('policy "host_only" leaves exactly one person in control', () => {
    expect(canControlVideo('host', 'host_only')).toBe(true);
    expect(canControlVideo('co_host', 'host_only')).toBe(false);
    expect(canControlVideo('member', 'host_only')).toBe(false);
    expect(canControlVideo('guest', 'host_only')).toBe(false);
  });

  it('is monotonic: tightening the policy never grants control to someone who lacked it', () => {
    for (const role of ROLES) {
      const everyone = canControlVideo(role, 'everyone');
      const cohosts = canControlVideo(role, 'host_and_cohosts');
      const hostOnly = canControlVideo(role, 'host_only');
      expect(everyone || !cohosts).toBe(true);
      expect(cohosts || !hostOnly).toBe(true);
    }
  });
});
