/**
 * Handle rules (PLAN.md Amendment A1, Phase 2.3).
 *
 * The handle is both the login identifier and the public name in every
 * participant list, which is why impersonation-adjacent names are blocked here
 * rather than left to moderation.
 */
import { describe, expect, it } from 'vitest';
import { HANDLE_MAX, HANDLE_MIN } from '@syncstudy/shared';
import { checkHandle, normalizeHandle } from '../handle';

describe('checkHandle — accepts', () => {
  it('ordinary handles', () => {
    for (const handle of [
      'priya',
      'sam',
      'a1b',
      'study_buddy',
      'x_1',
      'aditya_2026',
      '123',
      'a'.repeat(HANDLE_MAX),
    ]) {
      expect(checkHandle(handle), handle).toEqual({ ok: true });
    }
  });

  it('handles that only differ from valid ones by case or surrounding space', () => {
    // Signup lowercases on the way in, so the check has to as well or the rules
    // would apply to a different string than the one that gets stored.
    expect(checkHandle('Priya')).toEqual({ ok: true });
    expect(checkHandle('  priya  ')).toEqual({ ok: true });
    expect(checkHandle('PRIYA')).toEqual({ ok: true });
  });

  it('an underscore in the middle', () => {
    expect(checkHandle('study_group_4')).toEqual({ ok: true });
  });
});

describe('checkHandle — length', () => {
  it('rejects too short', () => {
    const result = checkHandle('ab');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('too_short');
    expect(result.message).toContain(String(HANDLE_MIN));

    expect(checkHandle('').reason).toBe('too_short');
    expect(checkHandle('a').reason).toBe('too_short');
    expect(checkHandle('  a  ').reason).toBe('too_short');
  });

  it('rejects too long', () => {
    const result = checkHandle('a'.repeat(HANDLE_MAX + 1));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('too_long');
    expect(result.message).toContain(String(HANDLE_MAX));
  });
});

describe('checkHandle — characters', () => {
  it('rejects anything outside [a-z0-9_]', () => {
    for (const bad of [
      'pri ya',
      'priya!',
      'priya-x',
      'priya.x',
      'priya@x',
      'priyá',
      'priya/x',
      'priya\\x',
      'pri\tya',
      'priya<script>',
      'приятно',
    ]) {
      expect(checkHandle(bad).reason, bad).toBe('invalid_chars');
    }
  });

  it('rejects a leading or trailing underscore', () => {
    // Leading and trailing underscores are the cheapest way to make a near-copy of
    // someone else's name, and they read as whitespace in most UI fonts.
    for (const bad of ['_priya', 'priya_', '_priya_', '___']) {
      expect(checkHandle(bad).reason, bad).toBe('edge_underscore');
    }
  });
});

describe('checkHandle — reserved words', () => {
  it('rejects the reserved list', () => {
    for (const reserved of [
      'admin',
      'administrator',
      'root',
      'support',
      'moderator',
      'syncstudy',
      'official',
      'security',
      'settings',
      'login',
      'signup',
      'dashboard',
      'guest',
      'host',
      'everyone',
      'null',
      'undefined',
      'deleted',
      'you',
    ]) {
      expect(checkHandle(reserved).reason, reserved).toBe('reserved');
    }
  });

  it('rejects reserved words regardless of case or surrounding whitespace', () => {
    expect(checkHandle('ADMIN').reason).toBe('reserved');
    expect(checkHandle('Admin').reason).toBe('reserved');
    expect(checkHandle('  admin  ').reason).toBe('reserved');
  });

  it('rejects the separator-stripped forms', () => {
    // a_d_m_i_n renders as "a d m i n" at a glance and is the obvious way around a
    // naive blocklist. The comparison strips underscores before matching.
    for (const evasion of [
      'a_d_m_i_n',
      'ad_min',
      'admi_n',
      'r_o_o_t',
      's_u_p_p_o_r_t',
      'sync_study',
      'mod_erator',
      'e_v_e_r_y_o_n_e',
    ]) {
      expect(checkHandle(evasion).reason, evasion).toBe('reserved');
    }
  });

  it('does not over-reach into handles that merely contain a reserved word', () => {
    // Blocking every substring would cost real users their names for no benefit:
    // the impersonation risk is in the whole handle, not in a fragment.
    for (const fine of ['admins_pet', 'roots', 'studying', 'hostel', 'guestbook']) {
      expect(checkHandle(fine), fine).toEqual({ ok: true });
    }
  });

  it('checks the length and character rules before the reserved list', () => {
    // The user sees one message; it should be the one describing the first thing
    // that is wrong with what they typed.
    expect(checkHandle('_admin').reason).toBe('edge_underscore');
    expect(checkHandle('ad min').reason).toBe('invalid_chars');
    expect(checkHandle('me').reason).toBe('too_short');
  });
});

describe('normalizeHandle', () => {
  it('trims and lowercases', () => {
    expect(normalizeHandle('  Priya  ')).toBe('priya');
    expect(normalizeHandle('PRIYA')).toBe('priya');
    expect(normalizeHandle('priya')).toBe('priya');
  });

  it('produces the value the uniqueness constraint is applied to', () => {
    // Case-insensitive uniqueness is implemented by storing the normalised form,
    // so these three signups must collide rather than create three accounts.
    const variants = ['Priya', 'PRIYA', ' priya '];
    expect(new Set(variants.map(normalizeHandle)).size).toBe(1);
  });
});
