'use client';

/**
 * "Something wrong?" (PLAN.md §14 Phase 10.9).
 *
 * The telemetry is the reason this exists rather than a support email address.
 * "The video kept jumping" is unactionable; the same sentence with a drift p95,
 * a hard-seek count and a clock offset beside it is a bug you can fix.
 *
 * What is attached is shown to the person before they send it. A support widget
 * that quietly harvests diagnostics is the kind of thing this product's privacy
 * page promises not to do, and the list is short enough to read.
 */
import { useCallback, useEffect, useState } from 'react';
import { LifeBuoy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { useCallStore } from '@/lib/stores/call-store';
import { useRoomStoreApi } from '@/lib/stores/room-store';
import { useSyncController } from '@/lib/sync/useSyncController';
import { cn } from '@/lib/utils';

export const SHOW_FEEDBACK_EVENT = 'syncstudy:show-feedback';

export function showFeedback(): void {
  window.dispatchEvent(new CustomEvent(SHOW_FEEDBACK_EVENT));
}

type Telemetry = Record<string, unknown>;

export function FeedbackDialog({ roomId }: { roomId: string }) {
  const controller = useSyncController();
  const store = useRoomStoreApi();
  const callStore = useCallStore((s) => s);

  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [telemetry, setTelemetry] = useState<Telemetry>({});

  const capture = useCallback((): Telemetry => {
    const room = store.getState();
    const sync = controller?.getTelemetrySnapshot() ?? {};
    return {
      ...sync,
      connection: room.connection.status,
      videoStatus: room.video.status,
      videoRevision: room.video.revision,
      participants: room.participants.length,
      inCall: callStore.status === 'joined',
      callPeers: Object.keys(callStore.peers).length,
    };
  }, [controller, store, callStore]);

  // Captured when the dialog OPENS, not when it is submitted: the numbers that
  // matter describe the moment something went wrong, and somebody typing for
  // thirty seconds has thirty seconds of calm telemetry after it.
  const openDialog = useCallback(() => {
    setTelemetry(capture());
    setMessage('');
    setError(null);
    setSent(false);
    setOpen(true);
  }, [capture]);

  useEffect(() => {
    const onRequest = (): void => openDialog();
    window.addEventListener(SHOW_FEEDBACK_EVENT, onRequest);
    return () => window.removeEventListener(SHOW_FEEDBACK_EVENT, onRequest);
  }, [openDialog]);

  const submit = async (): Promise<void> => {
    const trimmed = message.trim();
    if (trimmed.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          roomId,
          message: trimmed,
          telemetry,
          // Truncated, and only ever the browser string the server already sees
          // on every request — this adds no fingerprinting surface.
          userAgent: navigator.userAgent.slice(0, 200),
        }),
      });
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => null);
        const problem = body as { error?: { message?: string } } | null;
        setError(problem?.error?.message ?? 'Could not send that. Try again in a moment.');
        return;
      }
      setSent(true);
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) setOpen(next);
      }}
    >
      <DialogContent>
        <DialogTitle>Something wrong?</DialogTitle>
        <DialogDescription>
          Tell us what happened. What the room was doing at the moment you opened this is attached,
          which is usually what makes a report fixable.
        </DialogDescription>

        {sent ? (
          <div className="px-4 pb-2">
            <Callout tone="success">
              Sent. Thank you — this genuinely helps.
            </Callout>
          </div>
        ) : (
          <div className="flex flex-col gap-3 px-4 pb-1">
            <Textarea
              autoFocus
              rows={4}
              value={message}
              maxLength={1000}
              aria-label="What went wrong"
              placeholder="The video kept jumping backwards while Sam was talking…"
              onChange={(event) => setMessage(event.target.value)}
            />

            <details className="rounded-md border border-border">
              <summary
                className={cn(
                  'cursor-pointer select-none px-2.5 py-1.5 text-13 text-secondary',
                  'transition-colors duration-120 ease-standard hover:text-primary',
                )}
              >
                What gets attached
              </summary>
              <dl className="ss-scroll max-h-40 overflow-y-auto border-t border-border px-2.5 py-2">
                {Object.entries(telemetry).map(([key, value]) => (
                  <div key={key} className="flex items-baseline justify-between gap-3 py-0.5">
                    <dt className="text-[11px] text-tertiary">{key}</dt>
                    <dd className="text-[11px] tabular-nums text-secondary">{String(value)}</dd>
                  </div>
                ))}
                <div className="flex items-baseline justify-between gap-3 py-0.5">
                  <dt className="text-[11px] text-tertiary">browser</dt>
                  <dd className="max-w-[60%] truncate text-[11px] text-secondary">
                    {typeof navigator === 'undefined' ? '' : navigator.userAgent}
                  </dd>
                </div>
              </dl>
            </details>

            {error !== null ? <Callout tone="danger">{error}</Callout> : null}
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
            {sent ? 'Close' : 'Cancel'}
          </Button>
          {sent ? null : (
            <Button
              type="button"
              variant="primary"
              loading={busy}
              disabled={busy || message.trim().length === 0}
              onClick={() => {
                void submit();
              }}
            >
              <LifeBuoy size={16} strokeWidth={1.5} aria-hidden="true" />
              Send
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
