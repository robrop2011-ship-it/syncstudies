'use client';

/**
 * Join with a code (PLAN.md §2.2, §12.7).
 *
 * The rule this screen exists to satisfy: an invited student must be able to see
 * what they are joining — room name, host, how many people are already in it —
 * *before* they sign up. So the preview call needs no session, and the sign-in
 * prompt only appears once there is something concrete to sign in for.
 *
 * The lookup is a deliberate step rather than a keystroke-triggered one. The
 * preview endpoint is the room-code enumeration surface (§11.3) and is rate
 * limited to 20/min/IP; firing it on every keystroke would spend that budget on
 * one honest user typing eight characters.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, RotateCw, Users } from 'lucide-react';
import { ROOM_CODE_LENGTH, formatRoomCode } from '@syncstudy/shared';
import { Button, buttonVariants } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { extractRoomCode } from '@/components/room/room-code';
// Type-only, so nothing from the server module reaches the client bundle — and
// the preview shape is defined once, where the route that answers it lives.
import type { RoomPreview } from '@/lib/server/rooms';
import { ApiError, api, messageOf } from '@/lib/api';

interface Found {
  code: string;
  data: RoomPreview;
}

interface Blocker {
  tone: 'info' | 'warning' | 'danger';
  title: string;
  body: string;
}

const BAD_CODE = `Room codes are ${ROOM_CODE_LENGTH} characters, like K3M7-QP2X. They never contain 0, 1, I, L, O or U.`;

export function JoinFlow({ initialCode, signedIn }: { initialCode: string; signedIn: boolean }) {
  const router = useRouter();
  const [value, setValue] = useState(initialCode);
  const [found, setFound] = useState<Found | null>(null);
  const [passcode, setPasscode] = useState('');
  const [looking, setLooking] = useState(false);
  const [joining, setJoining] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const lookup = useCallback(async (raw: string): Promise<void> => {
    const code = extractRoomCode(raw);
    if (code === null) {
      setFound(null);
      setCodeError(BAD_CODE);
      return;
    }
    setCodeError(null);
    setActionError(null);
    setLooking(true);
    try {
      const data = await api.get<RoomPreview>(`/api/rooms/${code}/preview`);
      setFound({ code, data });
    } catch (error) {
      setFound(null);
      setCodeError(
        error instanceof ApiError && error.status === 404
          ? 'No room with that code. Check it with whoever invited you.'
          : messageOf(error),
      );
    } finally {
      setLooking(false);
    }
  }, []);

  // Arriving from a link or from the marketing page's inline form: look the room
  // up straight away rather than making them press a button they didn't ask for.
  const arrivingWith = useMemo(() => extractRoomCode(initialCode), [initialCode]);
  useEffect(() => {
    if (arrivingWith !== null) void lookup(arrivingWith);
  }, [arrivingWith, lookup]);

  async function join(): Promise<void> {
    if (found === null) return;
    setActionError(null);
    setJoining(true);
    try {
      const body = passcode.trim().length > 0 ? { passcode: passcode.trim() } : {};
      // `send`, not `post`: the response carries the room id and the resolved
      // role, and this screen needs neither — it navigates to a code it already
      // has, and the room page resolves the role from the session anyway.
      await api.send('POST', `/api/rooms/${found.code}/join`, body);
      // Deliberately leaves `joining` set: the button stays busy through the
      // navigation instead of flicking back to idle while the room page loads.
      router.push(`/r/${found.code}`);
    } catch (error) {
      setJoining(false);
      setActionError(messageOf(error));
    }
  }

  const blocker = found === null ? null : blockerFor(found.data);
  const nextPath = found === null ? '/dashboard' : `/r/${found.code}`;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1.5">
        <h1 className="text-xl font-semibold tracking-[-0.01em] text-primary">Join a room</h1>
        <p className="text-sm leading-5 text-secondary">
          Enter the {ROOM_CODE_LENGTH}-character code, or paste the whole link.
        </p>
      </header>

      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void lookup(value);
        }}
        className="flex flex-col gap-3"
      >
        <Field label="Room code" htmlFor="join-code" error={codeError ?? undefined}>
          <Input
            id="join-code"
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              if (codeError !== null) setCodeError(null);
            }}
            placeholder="K3M7-QP2X"
            autoComplete="off"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            invalid={codeError !== null}
            className="font-mono uppercase tracking-[0.04em]"
          />
        </Field>

        <div>
          <Button type="submit" variant="secondary" loading={looking} disabled={looking}>
            Find room
          </Button>
        </div>
      </form>

      {/* One region, announced once it settles — not on every keystroke. */}
      <div aria-live="polite" className="flex flex-col gap-4">
        {looking ? <PreviewSkeleton /> : null}

        {!looking && found !== null ? (
          <>
            <RoomCard code={found.code} data={found.data} />

            {blocker !== null ? (
              <Callout tone={blocker.tone} title={blocker.title}>
                {blocker.body}
              </Callout>
            ) : null}

            {actionError !== null ? <Callout tone="danger">{actionError}</Callout> : null}

            {blocker === null && signedIn && found.data.requiresPasscode ? (
              <Field
                label="Room passcode"
                htmlFor="join-passcode"
                hint="The host set a passcode on this room."
              >
                <Input
                  id="join-passcode"
                  type="password"
                  value={passcode}
                  onChange={(event) => setPasscode(event.target.value)}
                  autoComplete="off"
                />
              </Field>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              {blocker === null && signedIn ? (
                <Button
                  type="button"
                  variant="primary"
                  loading={joining}
                  disabled={joining}
                  onClick={() => {
                    void join();
                  }}
                >
                  {found.data.isMember ? 'Rejoin room' : 'Join room'}
                  <ArrowRight size={16} strokeWidth={1.5} aria-hidden="true" />
                </Button>
              ) : null}

              {blocker === null && !signedIn ? (
                <>
                  <Link
                    href={`/login?next=${encodeURIComponent(nextPath)}`}
                    className={buttonVariants({ variant: 'primary' })}
                  >
                    Sign in to join
                  </Link>
                  <Link
                    href={`/signup?next=${encodeURIComponent(nextPath)}`}
                    className={buttonVariants({ variant: 'secondary' })}
                  >
                    Create an account
                  </Link>
                </>
              ) : null}

              {blocker !== null && blocker.tone === 'warning' ? (
                <Button
                  type="button"
                  variant="secondary"
                  loading={looking}
                  onClick={() => {
                    void lookup(found.code);
                  }}
                >
                  <RotateCw size={16} strokeWidth={1.5} aria-hidden="true" />
                  Check again
                </Button>
              ) : null}

              <Link
                href={signedIn ? '/dashboard' : '/'}
                className="rounded-sm px-1 text-13 text-secondary underline-offset-2 hover:text-primary hover:underline"
              >
                {signedIn ? 'Back to your rooms' : 'Back to the home page'}
              </Link>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

function RoomCard({ code, data }: { code: string; data: RoomPreview }) {
  return (
    <div className="rounded-lg border border-border bg-surface-1 p-4">
      <p className="text-sm font-medium text-primary">{data.name}</p>
      {data.topic !== null && data.topic.length > 0 ? (
        <p className="mt-0.5 text-13 text-secondary">{data.topic}</p>
      ) : null}

      <dl className="mt-3 flex flex-col gap-1.5 text-13">
        <Row label="Host" value={data.hostName} />
        <Row
          label="In the room"
          value={`${data.participantCount} of ${data.maxParticipants}`}
          icon={<Users size={16} strokeWidth={1.5} aria-hidden="true" className="text-tertiary" />}
        />
        <Row label="Code" value={formatRoomCode(code)} mono />
      </dl>
    </div>
  );
}

function Row({
  label,
  value,
  mono = false,
  icon,
}: {
  label: string;
  value: string;
  mono?: boolean | undefined;
  icon?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-tertiary">{label}</dt>
      <dd
        className={`flex items-center gap-1.5 text-secondary ${mono ? 'font-mono tracking-[0.04em]' : ''}`}
      >
        {icon}
        {value}
      </dd>
    </div>
  );
}

function PreviewSkeleton() {
  return (
    <div className="rounded-lg border border-border bg-surface-1 p-4">
      <Skeleton className="h-5 w-40" />
      <Skeleton className="mt-1.5 h-4 w-56" />
      <div className="mt-3 flex flex-col gap-2">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
      </div>
    </div>
  );
}

/**
 * The one reason this person cannot walk in right now, or null.
 *
 * Order matters: a banned user is told they are banned, not that the room is
 * full, because the second answer would send them back to try again forever.
 */
function blockerFor(data: RoomPreview): Blocker | null {
  if (data.isBanned) {
    return {
      tone: 'danger',
      title: "You can't join this room",
      body: 'The host removed you from it. Only they can undo that.',
    };
  }
  if (data.status === 'ended') {
    return {
      tone: 'info',
      title: 'This room has ended',
      body: 'The host closed it. Ask them to start a new one and send you the code.',
    };
  }
  if (data.status === 'archived') {
    return {
      tone: 'info',
      title: 'This room is archived',
      body: 'Rooms are archived after 14 days without activity. The notes and chat are kept, but nobody can join.',
    };
  }
  if (data.isFull && !data.isMember) {
    return {
      tone: 'warning',
      title: 'This room is full',
      body: `${data.participantCount} of ${data.maxParticipants} people are already in it. You can join as soon as someone leaves.`,
    };
  }
  return null;
}
