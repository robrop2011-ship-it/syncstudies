'use client';

/**
 * Report a message (PLAN.md §3.5 H10, §11.6).
 *
 * The dialog closes on "Report" and says thank you either way. That is
 * deliberate: the endpoint refuses to reveal whether the target existed or
 * whether a report was already filed, so there is no outcome here worth
 * reporting back beyond "we have it". A dialog that showed a real error would
 * be the oracle the endpoint is careful not to be.
 *
 * Reporting does NOT hide the message locally. Personal blocking is v1.1, and
 * quietly hiding something on report would make the two indistinguishable —
 * someone would report a message to hide it and then wonder why the host never
 * saw anything.
 */
import { useState } from 'react';
import type { Schemas } from '@syncstudy/shared';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';
import type { ChatMessage } from '@/lib/stores/room-store';
import { cn } from '@/lib/utils';

type Reason = Schemas.CreateReportInput['reason'];

const REASONS: { value: Reason; label: string }[] = [
  { value: 'harassment', label: 'Harassment or bullying' },
  { value: 'hate', label: 'Hate speech' },
  { value: 'sexual_content', label: 'Sexual content' },
  { value: 'self_harm', label: 'Self-harm' },
  { value: 'spam', label: 'Spam or scams' },
  { value: 'other', label: 'Something else' },
];

const MAX_DETAILS = 1000;

export function ReportDialog({
  message,
  roomId,
  onClose,
  onDone,
}: {
  /** Null closes the dialog; the caller owns which message is being reported. */
  message: ChatMessage | null;
  roomId: string | null;
  onClose: () => void;
  onDone: (note: string) => void;
}) {
  const [reason, setReason] = useState<Reason>('harassment');
  const [details, setDetails] = useState('');
  const [sending, setSending] = useState(false);

  async function submit(): Promise<void> {
    if (message === null || sending) return;
    setSending(true);
    try {
      await api.post('/api/reports', {
        targetType: 'message',
        targetId: message.id,
        ...(roomId === null ? {} : { roomId }),
        reason,
        ...(details.trim().length === 0 ? {} : { details: details.trim() }),
      });
    } catch {
      // Swallowed on purpose — see the file header. A failed report is logged
      // server-side; telling the reporter which ids failed is the oracle.
    } finally {
      setSending(false);
      setReason('harassment');
      setDetails('');
      onClose();
      onDone('Report sent. Thank you — a moderator will look at it.');
    }
  }

  return (
    <Dialog open={message !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-w-md">
        <DialogTitle>Report this message</DialogTitle>
        <DialogDescription>
          A copy of the message is saved with your report, so it can still be reviewed if it is
          deleted. Reports are read by a person, usually within a day.
        </DialogDescription>

        {message !== null ? (
          <blockquote className="mt-3 max-h-24 overflow-y-auto rounded-md border border-border bg-surface-2 px-3 py-2 text-13 text-secondary">
            <span className="line-clamp-4 whitespace-pre-wrap break-words">{message.body}</span>
          </blockquote>
        ) : null}

        <fieldset className="mt-4">
          <legend className="pb-2 text-13 font-medium text-primary">What is wrong with it?</legend>
          <div className="flex flex-col gap-0.5">
            {REASONS.map((option) => (
              <label
                key={option.value}
                className={cn(
                  'flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-13 text-primary',
                  'transition-colors duration-120 ease-standard hover:bg-surface-2',
                )}
              >
                <input
                  type="radio"
                  name="report-reason"
                  value={option.value}
                  checked={reason === option.value}
                  onChange={() => setReason(option.value)}
                  className="accent-accent"
                />
                {option.label}
              </label>
            ))}
          </div>
        </fieldset>

        <label className="mt-3 block">
          <span className="pb-1.5 block text-13 font-medium text-primary">
            Anything else? <span className="font-normal text-tertiary">Optional</span>
          </span>
          <Textarea
            rows={3}
            maxLength={MAX_DETAILS}
            value={details}
            onChange={(event) => setDetails(event.target.value)}
            placeholder="Context that would help someone reviewing this."
          />
        </label>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={sending}>
            Cancel
          </Button>
          <Button type="button" variant="primary" loading={sending} onClick={() => void submit()}>
            Report
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
