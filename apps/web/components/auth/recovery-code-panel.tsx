'use client';

/**
 * The one-time recovery code (PLAN.md Amendment A1, feature A2).
 *
 * Shown at signup, after a recovery, and whenever a new code is issued from
 * settings. Only the argon2id hash is stored, so this render is genuinely the
 * only time this string exists anywhere the user can reach — which is why the
 * copy says so plainly and why the continue button is gated on an
 * acknowledgement rather than being one more thing to click past.
 */
import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { CopyButton } from '@/components/ui/copy-button';

export interface RecoveryCodePanelProps {
  code: string;
  /** When provided, an acknowledgement checkbox gates this action. */
  onContinue?: (() => void) | undefined;
  continueLabel?: string | undefined;
  busy?: boolean | undefined;
}

export function RecoveryCodePanel(props: RecoveryCodePanelProps) {
  const { code, onContinue, continueLabel = 'Continue', busy = false } = props;
  const [acknowledged, setAcknowledged] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-border bg-surface-1 p-4">
        <div className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.04em] text-tertiary">
          <KeyRound size={16} strokeWidth={1.5} aria-hidden="true" />
          Recovery code
        </div>
        <p
          className="select-all break-all font-mono text-base leading-6 tracking-[0.04em] text-primary"
          data-testid="recovery-code"
        >
          {code}
        </p>
        <div className="mt-3">
          <CopyButton value={code} label="Copy code" />
        </div>
      </div>

      <Callout tone="warning" title="This is shown once">
        SyncStudy accounts have no email address, so there is no reset link we can send you. If you
        forget your password, this code is the only way back in. Store it in your password manager or
        write it down somewhere you will still have it in a year.
      </Callout>

      {onContinue !== undefined ? (
        <div className="flex flex-col gap-3">
          <label className="flex cursor-pointer items-start gap-2.5 text-sm text-secondary">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => {
                setAcknowledged(event.target.checked);
              }}
              className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer rounded-sm border border-border-strong accent-accent"
            />
            I have saved my recovery code somewhere safe.
          </label>
          <Button
            type="button"
            variant="primary"
            disabled={!acknowledged || busy}
            loading={busy}
            onClick={onContinue}
          >
            {continueLabel}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
