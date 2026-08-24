'use client';

/**
 * Recovery code management (PLAN.md feature A2).
 *
 * We store only the argon2id hash, so "show me my code" is impossible by design.
 * The honest version of that button is "give me a new one", which is what this
 * card does — and it says plainly that the old one dies in the process.
 */
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { PasswordInput } from '@/components/auth/password-input';
import { RecoveryCodePanel } from '@/components/auth/recovery-code-panel';
import { api, fieldsOf, messageOf } from '@/lib/api';

export function RecoveryCodeCard({ issuedAt }: { issuedAt: string | null }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState<string | null>(null);

  const generate = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ recoveryCode: string }>('/api/auth/recovery-code', {
        password,
      });
      setCode(result.recoveryCode);
      setPassword('');
      setOpen(false);
    } catch (caught) {
      setError(fieldsOf(caught).password ?? messageOf(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader
        title="Recovery code"
        description="The only way back into this account if you forget your password."
      />
      <CardBody>
        <div className="flex flex-col gap-4">
          <p className="text-sm leading-5 text-secondary">
            {issuedAt === null
              ? 'This account has no recovery code right now. Generate one and keep it somewhere safe.'
              : `Your current code was issued on ${issuedAt}. We only keep a hash of it, so it cannot be shown again — if you have lost it, generate a replacement.`}
          </p>

          {code !== null ? <RecoveryCodePanel code={code} /> : null}

          <div>
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogTrigger asChild>
                <Button variant="secondary">Generate a new code</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogTitle>Generate a new recovery code</DialogTitle>
                <DialogDescription>
                  Your current recovery code stops working the moment the new one is created. If
                  someone else has a copy of the old code, this is how you take it away from them.
                </DialogDescription>

                <div className="px-4 pb-4">
                  <Field
                    label="Your password"
                    htmlFor="recovery-code-password"
                    error={error ?? undefined}
                  >
                    <PasswordInput
                      id="recovery-code-password"
                      autoComplete="current-password"
                      value={password}
                      invalid={error !== null}
                      onChange={(event) => {
                        setPassword(event.target.value);
                        if (error !== null) setError(null);
                      }}
                    />
                  </Field>
                </div>

                <DialogFooter>
                  <DialogClose asChild>
                    <Button variant="secondary" type="button">
                      Cancel
                    </Button>
                  </DialogClose>
                  <Button
                    type="button"
                    variant="primary"
                    loading={busy}
                    disabled={busy || password.length === 0}
                    onClick={() => {
                      void generate();
                    }}
                  >
                    Generate code
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>

          <Callout tone="info" title="Why we cannot email you a reset link">
            SyncStudy accounts have no email address. There is nothing to phish, nothing to leak and
            nobody to notify — and no way for us to prove an account is yours. That is the whole
            trade, and this code is your side of it.
          </Callout>
        </div>
      </CardBody>
    </Card>
  );
}
