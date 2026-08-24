'use client';

/**
 * Quick join from the dashboard (PLAN.md §2.2, §3.2 R2).
 *
 * This is the shortcut, not the full flow. Someone here is already signed in and
 * already has the code in their clipboard, so it goes straight to `/r/{code}` —
 * the room page resolves membership, capacity and bans and shows whichever of
 * those applies. `/join` is the version with the preview, for people arriving
 * from a link who may not have an account yet.
 *
 * Everything is normalised before we navigate: separators stripped, uppercased,
 * checked against the 30-symbol alphabet, and a pasted invite URL reduced to the
 * code inside it. A typed `0`, `1`, `I`, `L`, `O` or `U` is not a code at all —
 * those characters were removed from the alphabet precisely so a misread can
 * never resolve to somebody else's room — so we say that here rather than
 * sending them to a 404.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ROOM_CODE_LENGTH } from '@syncstudy/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { extractRoomCode } from '@/components/room/room-code';

export function JoinRoomForm() {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [navigating, setNavigating] = useState(false);

  return (
    <form
      className="flex flex-col gap-1.5"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const normalized = extractRoomCode(code);
        if (normalized === null) {
          setError(`Room codes are ${ROOM_CODE_LENGTH} characters, like K3M7-QP2X.`);
          return;
        }
        setError(null);
        setNavigating(true);
        router.push(`/r/${normalized}`);
      }}
    >
      <div className="flex items-start gap-2">
        <div className="w-[180px]">
          <label htmlFor="room-code" className="sr-only">
            Room code
          </label>
          <Input
            id="room-code"
            value={code}
            onChange={(event) => {
              setCode(event.target.value);
              if (error !== null) setError(null);
            }}
            placeholder="K3M7-QP2X"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            invalid={error !== null}
            className="font-mono uppercase tracking-[0.04em]"
          />
        </div>
        <Button type="submit" variant="secondary" loading={navigating} disabled={navigating}>
          Join
        </Button>
      </div>

      {error !== null ? (
        <p className="text-13 text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
