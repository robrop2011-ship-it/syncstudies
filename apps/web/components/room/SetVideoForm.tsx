'use client';

/**
 * Paste a YouTube link (PLAN.md §5.3 quirk 5, §8.4 `set_video`, §12.5).
 *
 * The important decision here is *when* a bad link is caught. Some videos forbid
 * embedded playback, and the only way to find out from inside an iframe is to
 * load it and wait for error 101/150 — by which point everybody in the room is
 * staring at a black rectangle and the person who pasted it has already moved on.
 * So the link is probed **server-side at paste time**, and a video that cannot be
 * embedded is refused right here, next to the input, with a sentence that says
 * what to do instead.
 *
 * The probe is a checkpoint, not a gate: if the checker itself is unreachable we
 * set the video anyway (see `PROBE_UNAVAILABLE`). Refusing every link because a
 * validation endpoint is down would take the room from "one video might not
 * play" to "no video can play", and the player's own error state already handles
 * the case we would have caught.
 *
 * Only rendered for users with `video.set` (host and co-hosts, §11.2). The
 * server re-checks that permission; this is the affordance, not the rule.
 */
import { useRef, useState, type FormEvent } from 'react';
import { parseYouTubeUrl, type ControlAck } from '@syncstudy/shared';
import { ApiError, api, messageOf } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useSocket } from '@/lib/socket/provider';
import { useConnection } from '@/lib/stores/room-store';
import { useSyncController } from '@/lib/sync/useSyncController';
import { cn } from '@/lib/utils';

const PROBE_PATH = '/api/video/probe';
const ACK_TIMEOUT_MS = 8_000;

export const EMBED_DENIED_MESSAGE =
  "This video can't be played outside YouTube. Try another link.";

/**
 * Error codes that mean "the checker did not answer", as opposed to "the checker
 * said no". Only the first group is allowed to fall through and set the video.
 */
const PROBE_UNAVAILABLE = new Set(['internal', 'malformed_response', 'network', 'timeout']);

/** Mirrors `VideoProbeResult` from app/api/video/probe/probe.ts. */
interface Probe {
  videoId: string;
  title: string | null;
  durationSec: number | null;
  embeddable: boolean;
  reason: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Read the probe response defensively.
 *
 * `embeddable` blocks only when it is explicitly `false`. A missing field means
 * the endpoint did not answer that question, and treating silence as a refusal
 * would reject every video on the day someone renames a key.
 */
function readProbe(payload: unknown, fallbackId: string): Probe {
  if (!isRecord(payload)) {
    return { videoId: fallbackId, title: null, durationSec: null, embeddable: true, reason: null };
  }
  const videoId = typeof payload.videoId === 'string' ? payload.videoId : fallbackId;
  const title = typeof payload.title === 'string' && payload.title.length > 0 ? payload.title : null;
  const duration =
    typeof payload.durationSec === 'number' && Number.isFinite(payload.durationSec)
      ? payload.durationSec
      : null;
  return {
    videoId,
    title,
    durationSec: duration,
    embeddable: payload.embeddable !== false,
    reason: typeof payload.reason === 'string' ? payload.reason : null,
  };
}

/** A "no" from YouTube is a successful probe with a negative answer, not an error. */
function refusalMessage(probe: Probe): string {
  switch (probe.reason) {
    case 'not_found':
      return 'YouTube has no video at that link. Check the address and try again.';
    case 'unavailable':
      return "YouTube won't play that video right now. Try another link.";
    default:
      return EMBED_DENIED_MESSAGE;
  }
}

/**
 * `video:set` acks with a `ControlAck`, not the `Ack` shape `socket-ack.ts`
 * wraps, and an ack that never arrives must not hang the button forever.
 */
function setVideoAck(run: (ack: (result: ControlAck) => void) => void): Promise<ControlAck | null> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, ACK_TIMEOUT_MS);

    run((result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    });
  });
}

function rejectionMessage(ack: ControlAck): string {
  switch (ack.reason) {
    case 'not_permitted':
      return 'You do not have permission to set the video in this room.';
    case 'rate_limited':
      return 'Too many changes just now. Wait a few seconds and try again.';
    case 'no_video':
      return 'YouTube did not accept that video. Try another link.';
    case 'recently_changed':
    case 'stale_revision':
      return 'Someone else just changed the video. Have a look, then try again.';
    default:
      return 'The room did not accept that video. Try again.';
  }
}

export function SetVideoForm({
  id = 'video-url',
  className,
}: {
  /** Distinct per instance: the empty state and the error state both render one. */
  id?: string | undefined;
  className?: string | undefined;
}) {
  const socket = useSocket();
  const controller = useSyncController();
  const connection = useConnection();

  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const offline = connection.status !== 'connected' || socket === null;
  const messageId = `${id}-message`;
  const message = error ?? (offline ? 'Reconnecting to the room…' : null);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy || offline || socket === null) return;

    const parsed = parseYouTubeUrl(value);
    if (parsed === null) {
      setError('That is not a YouTube link. Paste the whole address from the address bar.');
      inputRef.current?.focus();
      return;
    }

    setBusy(true);
    setError(null);

    let probe: Probe = {
      videoId: parsed.videoId,
      title: null,
      durationSec: null,
      embeddable: true,
      reason: null,
    };

    try {
      probe = readProbe(await api.post<unknown>(PROBE_PATH, { url: value.trim() }), parsed.videoId);
    } catch (failure) {
      const code = failure instanceof ApiError ? failure.code : 'internal';
      if (!PROBE_UNAVAILABLE.has(code)) {
        setBusy(false);
        setError(
          code === 'not_found'
            ? 'YouTube has no video at that link.'
            : code === 'forbidden'
              ? EMBED_DENIED_MESSAGE
              : messageOf(failure),
        );
        return;
      }
      // The checker is down. Carry on with what the URL itself told us.
    }

    // `unavailable` means the CHECKER could not reach YouTube — fetch threw, DNS
    // failed, the 5s timeout fired, oEmbed 5xx'd. It is not a verdict about the
    // video. Blocking on it fails closed on exactly the case the thrown-error
    // branch above deliberately fails open on, so an outage at YouTube's oEmbed
    // endpoint would stop anyone setting a perfectly good video. Only a real
    // verdict — the owner disabled embedding, or there is no such video — refuses.
    if (!probe.embeddable && probe.reason !== 'unavailable') {
      setBusy(false);
      setError(refusalMessage(probe));
      return;
    }

    // Built by spread rather than with explicit `undefined`s:
    // `exactOptionalPropertyTypes` makes `{ title: undefined }` a different type
    // from `{}`, and the socket's payload type wants the second one.
    const ack = await setVideoAck((done) => {
      socket.emit(
        'video:set',
        {
          provider: 'youtube' as const,
          videoRef: probe.videoId,
          ...(probe.title === null ? {} : { title: probe.title }),
          ...(probe.durationSec === null ? {} : { durationSec: probe.durationSec }),
        },
        done,
      );
    });

    setBusy(false);

    if (ack === null) {
      setError('No answer from the room. Check your connection and try again.');
      return;
    }
    if (!ack.ok) {
      setError(rejectionMessage(ack));
      return;
    }

    setValue('');

    // A pasted `?t=90` says where to start watching, and `set_video` always
    // anchors the room at zero (§8.4) — so honouring it takes one ordinary seek
    // afterwards, which moves everybody, not just the person who pasted it.
    //
    // It applies when a player is already attached, i.e. when the room is
    // swapping videos. For the room's FIRST video there is no controller yet and
    // the offset is dropped; the room simply starts at zero, which is what it
    // would have done anyway.
    if (parsed.startSec > 0) void controller?.seek(parsed.startSec);
  }

  return (
    <form
      className={cn('flex w-full flex-col gap-2', className)}
      onSubmit={(event) => {
        void submit(event);
      }}
      noValidate
    >
      {/* The label is for screen readers only: the empty state above the form
          already says what this is in a full sentence, and a third line of chrome
          in a 380px-wide column is how a room starts to look like a settings page. */}
      <label htmlFor={id} className="sr-only">
        YouTube link
      </label>

      <div className="flex items-start gap-2">
        <Input
          id={id}
          ref={inputRef}
          value={value}
          invalid={error !== null}
          disabled={busy}
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="https://www.youtube.com/watch?v=…"
          aria-describedby={message === null ? undefined : messageId}
          onChange={(event) => {
            setValue(event.target.value);
            if (error !== null) setError(null);
          }}
          className="flex-1"
        />
        <Button
          type="submit"
          variant="primary"
          loading={busy}
          disabled={offline || value.trim().length === 0}
        >
          Load video
        </Button>
      </div>

      {/* Inline, next to the cause, in --danger text. Never a toast (§12.5). */}
      {message === null ? null : (
        <p
          id={messageId}
          role={error === null ? undefined : 'alert'}
          className={cn('text-13', error === null ? 'text-tertiary' : 'text-danger')}
        >
          {message}
        </p>
      )}
    </form>
  );
}
