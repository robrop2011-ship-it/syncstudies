'use client';

/**
 * Create a room (PLAN.md §2.1, §3.2 R1).
 *
 * Four fields and one button. The critical path is "create a room → studying in
 * under 90 seconds" (§2.1), so everything except the name has a sensible default
 * and nothing here blocks on a second screen.
 *
 * Errors land inline next to the field that caused them (§12.5). The only thing
 * that gets a block-level message is a failure with no field to attach to — the
 * daily create limit, or the network being gone.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  DEFAULT_MAX_PARTICIPANTS,
  MAX_ROOM_NAME,
  MAX_ROOM_TOPIC,
  MESH_AUDIO_MAX,
  ROOM_PARTICIPANTS_CEILING,
  ROOM_PARTICIPANTS_FLOOR,
  Schemas,
} from '@syncstudy/shared';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/app/native-select';
// Type-only, so nothing from the server module reaches the client bundle.
import type { RoomSummary } from '@/lib/server/rooms';
import { api, fieldsOf, messageOf } from '@/lib/api';

/** `POST /api/rooms` — the same envelope the route builds. */
interface CreateRoomResult {
  room: RoomSummary;
}

const CAPACITY_OPTIONS: number[] = [];
for (let n = ROOM_PARTICIPANTS_FLOOR; n <= ROOM_PARTICIPANTS_CEILING; n += 1) {
  CAPACITY_OPTIONS.push(n);
}

const CONTROL_OPTIONS: ReadonlyArray<{ value: Schemas.PlaybackControl; label: string }> = [
  { value: 'everyone', label: 'Everyone in the room' },
  { value: 'host_and_cohosts', label: 'You and your co-hosts' },
  { value: 'host_only', label: 'Only you' },
];

/**
 * Zod's default copy is not our copy (§12.2): "String must contain at least 1
 * character(s)" is a validator talking to a developer. The schema lives in
 * @syncstudy/shared and is shared with the server, so the phrasing is fixed
 * there and translated here, where the reader is.
 */
function humanise(raw: string | undefined, tooShort: string, tooLong: string): string | undefined {
  if (raw === undefined) return undefined;
  if (/at least/i.test(raw)) return tooShort;
  if (/at most/i.test(raw)) return tooLong;
  return raw;
}

export function CreateRoomForm() {
  const router = useRouter();
  const [formError, setFormError] = useState<string | null>(null);
  // Separate from `isSubmitting`: the button must stay busy through the
  // navigation as well, or it flicks back to idle while the room page loads.
  const [leaving, setLeaving] = useState(false);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<Schemas.CreateRoomInput>({
    resolver: zodResolver(Schemas.CreateRoomInput),
    defaultValues: {
      name: '',
      topic: '',
      maxParticipants: DEFAULT_MAX_PARTICIPANTS,
      playbackControl: 'everyone',
    },
  });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    const topic = (values.topic ?? '').trim();

    try {
      const result = await api.post<CreateRoomResult>('/api/rooms', {
        name: values.name.trim(),
        // An empty topic is the absence of a topic, not an empty string.
        topic: topic.length > 0 ? topic : null,
        maxParticipants: values.maxParticipants,
        playbackControl: values.playbackControl,
      });
      setLeaving(true);
      router.push(`/r/${result.room.code}`);
    } catch (error) {
      const fields = fieldsOf(error);
      let placed = false;
      for (const key of ['name', 'topic', 'maxParticipants', 'playbackControl'] as const) {
        const message = fields[key];
        if (message !== undefined) {
          setError(key, { type: 'server', message });
          placed = true;
        }
      }
      if (!placed) setFormError(messageOf(error));
    }
  });

  const busy = isSubmitting || leaving;
  const nameError = humanise(
    errors.name?.message,
    'Give the room a name your group will recognise.',
    `Room names are at most ${MAX_ROOM_NAME} characters.`,
  );
  const topicError = humanise(
    errors.topic?.message,
    'Leave this blank if there is no topic.',
    `Topics are at most ${MAX_ROOM_TOPIC} characters.`,
  );

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1.5">
        <h1 className="text-xl font-semibold tracking-[-0.01em] text-primary">Create a room</h1>
        <p className="text-sm leading-5 text-secondary">
          You get an 8-character code to share. Nobody can find the room without it.
        </p>
      </header>

      {formError !== null ? <Callout tone="danger">{formError}</Callout> : null}

      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        <Field
          label="Room name"
          htmlFor="name"
          hint="What your group sees in the sidebar."
          error={nameError}
        >
          <Input
            id="name"
            autoComplete="off"
            maxLength={MAX_ROOM_NAME}
            placeholder="Organic Chem — Ch. 7"
            invalid={nameError !== undefined}
            {...register('name')}
          />
        </Field>

        <Field
          label="Topic"
          htmlFor="topic"
          optional
          hint="One line under the room name. Useful when you keep several rooms open."
          error={topicError}
        >
          <Input
            id="topic"
            autoComplete="off"
            maxLength={MAX_ROOM_TOPIC}
            placeholder="Aldehydes and ketones"
            invalid={topicError !== undefined}
            {...register('topic')}
          />
        </Field>

        <Field
          label="Maximum people"
          htmlFor="maxParticipants"
          hint={`Voice is capped at ${MESH_AUDIO_MAX} people. A bigger room can still watch, chat and take notes together.`}
          error={errors.maxParticipants?.message}
        >
          <NativeSelect
            id="maxParticipants"
            invalid={errors.maxParticipants !== undefined}
            {...register('maxParticipants', { valueAsNumber: true })}
          >
            {CAPACITY_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n} people
              </option>
            ))}
          </NativeSelect>
        </Field>

        <Field
          label="Who can control playback"
          htmlFor="playbackControl"
          hint="Change this at any time from inside the room."
          error={errors.playbackControl?.message}
        >
          <NativeSelect
            id="playbackControl"
            invalid={errors.playbackControl !== undefined}
            {...register('playbackControl')}
          >
            {CONTROL_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </NativeSelect>
        </Field>

        <div className="mt-1 flex items-center gap-2">
          <Button type="submit" variant="primary" loading={busy} disabled={busy}>
            Create room
          </Button>
          <Link
            href="/dashboard"
            className="rounded-sm px-1 text-13 text-secondary underline-offset-2 hover:text-primary hover:underline"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}
