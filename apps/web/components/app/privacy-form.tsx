'use client';

/**
 * Privacy and appearance settings (PLAN.md feature A6, §11.9).
 *
 * Each control saves on change — a settings page with a Save button at the
 * bottom is a settings page where half the toggles silently do nothing.
 *
 * Minor accounts see their locked protections, disabled, with the reason next to
 * them. Hiding the controls would leave a 16-year-old wondering where the
 * privacy settings went; showing them greyed out with an explanation says what
 * is happening and why.
 */
import type { ReactNode } from 'react';
import { useState } from 'react';
import { Callout } from '@/components/ui/callout';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { NativeSelect } from '@/components/app/native-select';
import { applyReduceMotion } from '@/components/app/account-preferences';
import { api, messageOf } from '@/lib/api';
import { setTheme } from '@/lib/theme';
import type { ProfileVisibility, SettingsView, ThemePreference } from '@/lib/server/views';

type SettingsPatch = Partial<
  Pick<
    SettingsView,
    | 'profileVisibility'
    | 'showOnlineStatus'
    | 'theme'
    | 'joinMuted'
    | 'joinCameraOff'
    | 'pushToTalk'
    | 'reduceMotion'
    | 'hideIpFromPeers'
  >
>;

type SaveState = 'idle' | 'saving' | 'saved';

const LOCK_PROFILE = 'Always private on an account for under-18s.';
const LOCK_ONLINE = 'Always hidden on an account for under-18s.';
const LOCK_RELAY = 'Always on for an account for under-18s.';

function toVisibility(value: string): ProfileVisibility {
  return value === 'public' || value === 'private' ? value : 'rooms_only';
}

function toTheme(value: string): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'system';
}

export function PrivacyForm({
  settings: initial,
  isMinor,
}: {
  settings: SettingsView;
  isMinor: boolean;
}) {
  const [settings, setSettings] = useState<SettingsView>(initial);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<SaveState>('idle');

  const update = async (patch: SettingsPatch) => {
    const previous = settings;
    setSettings({ ...settings, ...patch });
    setError(null);
    setState('saving');
    try {
      const next = await api.patch<SettingsView>('/api/me/settings', patch);
      setSettings(next);
      setState('saved');
      // Also stamp the device preference, so the header's toggle agrees with
      // what this page just saved instead of silently disagreeing with it.
      if (patch.theme !== undefined) setTheme(next.theme);
      if (patch.reduceMotion !== undefined) applyReduceMotion(next.reduceMotion);
    } catch (caught) {
      // Put the switch back where it was: leaving it flipped would show a
      // protection as off when the server still has it on.
      setSettings(previous);
      setState('idle');
      setError(messageOf(caught));
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {isMinor ? (
        <Callout tone="info" title="Account for under-18s">
          A few protections are fixed on this account: your profile is private, your online status
          is hidden, and calls always route through our relay so nobody in the call sees your IP
          address. Everything else on this page is yours to change.
        </Callout>
      ) : null}

      {error !== null ? <Callout tone="danger">{error}</Callout> : null}

      <div className="-mb-3 flex h-4 items-center justify-end text-xs text-tertiary" aria-live="polite">
        {state === 'saving' ? 'Saving' : null}
        {state === 'saved' ? 'Saved' : null}
      </div>

      <Card>
        <CardHeader title="Profile and presence" description="Who can see you, and when." />
        <CardBody>
          <div className="flex flex-col">
            <SelectRow
              id="profile-visibility"
              label="Profile visibility"
              description="Who can open your profile."
              locked={isMinor}
              lockReason={isMinor ? LOCK_PROFILE : null}
            >
              <NativeSelect
                id="profile-visibility"
                value={settings.profileVisibility}
                disabled={isMinor}
                onChange={(event) => {
                  void update({ profileVisibility: toVisibility(event.target.value) });
                }}
              >
                <option value="public">Anyone</option>
                <option value="rooms_only">People in my rooms</option>
                <option value="private">Nobody</option>
              </NativeSelect>
            </SelectRow>

            <ToggleRow
              id="show-online-status"
              label="Show when I am online"
              description="Lets people in your rooms see that you are around."
              checked={settings.showOnlineStatus}
              locked={isMinor}
              lockReason={isMinor ? LOCK_ONLINE : null}
              onChange={(value) => {
                void update({ showOnlineStatus: value });
              }}
            />
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Calls"
          description="Voice and video are peer-to-peer, which has one privacy consequence worth knowing about."
        />
        <CardBody>
          <ToggleRow
            id="hide-ip"
            label="Hide my IP address in calls"
            description="Calls normally connect directly between devices, which means other people in the call can see your IP address. This routes your audio and video through our relay instead. It costs a little latency."
            checked={settings.hideIpFromPeers}
            locked={isMinor}
            lockReason={isMinor ? LOCK_RELAY : null}
            onChange={(value) => {
              void update({ hideIpFromPeers: value });
            }}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Joining a room" description="How you arrive when you open a room." />
        <CardBody>
          <div className="flex flex-col">
            <ToggleRow
              id="join-muted"
              label="Join muted"
              description="Your microphone starts off."
              checked={settings.joinMuted}
              onChange={(value) => {
                void update({ joinMuted: value });
              }}
            />
            <ToggleRow
              id="join-camera-off"
              label="Join with camera off"
              description="Your camera starts off."
              checked={settings.joinCameraOff}
              onChange={(value) => {
                void update({ joinCameraOff: value });
              }}
            />
            <ToggleRow
              id="push-to-talk"
              label="Push to talk"
              description="Hold Space to speak instead of staying unmuted. Space no longer plays or pauses the video while this is on."
              checked={settings.pushToTalk}
              onChange={(value) => {
                void update({ pushToTalk: value });
              }}
            />
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Appearance" description="Applies on this and every device you sign in on." />
        <CardBody>
          <div className="flex flex-col">
            <SelectRow
              id="theme"
              label="Theme"
              description="Saved to your account, so it follows you to another computer. The control in the header changes this device only. Rooms are always dark whatever this says — a bright interface around a video is unpleasant at 1am."
              locked={false}
              lockReason={null}
            >
              <NativeSelect
                id="theme"
                value={settings.theme}
                onChange={(event) => {
                  void update({ theme: toTheme(event.target.value) });
                }}
              >
                <option value="system">Match my system</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </NativeSelect>
            </SelectRow>

            <ToggleRow
              id="reduce-motion"
              label="Reduce motion"
              description="Removes the small transitions in the interface."
              checked={settings.reduceMotion}
              onChange={(value) => {
                void update({ reduceMotion: value });
              }}
            />
          </div>
        </CardBody>
      </Card>
    </div>
  );
}

function RowShell({
  label,
  description,
  htmlFor,
  lockReason,
  control,
}: {
  label: string;
  description: string;
  htmlFor: string;
  lockReason: string | null;
  control: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-6 border-b border-border py-3.5 first:pt-0 last:border-0 last:pb-0">
      <div className="min-w-0">
        <label htmlFor={htmlFor} className="block text-sm font-medium text-primary">
          {label}
        </label>
        <p className="mt-0.5 text-13 leading-5 text-secondary">{description}</p>
        {lockReason !== null ? (
          <p className="mt-1 text-13 leading-5 text-tertiary">{lockReason}</p>
        ) : null}
      </div>
      <div className="shrink-0 pt-0.5">{control}</div>
    </div>
  );
}

function ToggleRow({
  id,
  label,
  description,
  checked,
  onChange,
  locked = false,
  lockReason = null,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  locked?: boolean;
  lockReason?: string | null;
}) {
  return (
    <RowShell
      label={label}
      description={description}
      htmlFor={id}
      lockReason={lockReason}
      control={<Switch id={id} checked={checked} onCheckedChange={onChange} disabled={locked} />}
    />
  );
}

function SelectRow({
  id,
  label,
  description,
  locked,
  lockReason,
  children,
}: {
  id: string;
  label: string;
  description: string;
  locked: boolean;
  lockReason: string | null;
  children: ReactNode;
}) {
  return (
    <RowShell
      label={label}
      description={description}
      htmlFor={id}
      lockReason={locked ? lockReason : null}
      control={<div className="w-[200px]">{children}</div>}
    />
  );
}
