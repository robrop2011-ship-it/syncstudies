'use client';

/**
 * Account deletion (PLAN.md feature A8, §11.9).
 *
 * The dialog spells out what actually happens rather than asking "Are you sure?"
 * — including the part people care about and nobody tells them: their messages
 * stay in the rooms they wrote them in, attributed to "Deleted user", because
 * tearing them out would shred a study group's history over one person leaving.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
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
import { api, fieldsOf, messageOf } from '@/lib/api';

export function DeleteAccountCard() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const deleteAccount = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.send('DELETE', '/api/me', { password });
      setOpen(false);
      router.push('/');
      router.refresh();
    } catch (caught) {
      setError(fieldsOf(caught).password ?? messageOf(caught));
      setBusy(false);
    }
  };

  return (
    <Card className="border-danger">
      <CardHeader
        title="Delete account"
        description="Ends the account and removes your profile. This cannot be undone after 7 days."
      />
      <CardBody>
        <div className="flex flex-col gap-4">
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm leading-5 text-secondary">
            <li>You are signed out everywhere and cannot sign in again.</li>
            <li>Your display name, bio, school and avatar are removed immediately.</li>
            <li>Your recovery code is destroyed, so the account cannot be recovered into.</li>
            <li>
              Messages and notes you wrote stay in their rooms, attributed to &ldquo;Deleted
              user&rdquo;, so the people you studied with keep their history.
            </li>
            <li>Everything else is permanently deleted after 7 days.</li>
            <li>Your username is not released to anyone else.</li>
          </ul>

          <div>
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogTrigger asChild>
                <Button variant="danger">Delete my account</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogTitle>Delete this account?</DialogTitle>
                <DialogDescription>
                  This signs you out everywhere and starts a 7-day countdown. After that, everything
                  except the messages already anonymised in your rooms is gone for good. There is no
                  email on this account, so we cannot send you a link to undo it.
                </DialogDescription>

                <div className="px-4 pb-4">
                  <Field label="Your password" htmlFor="delete-password" error={error ?? undefined}>
                    <PasswordInput
                      id="delete-password"
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
                      Keep my account
                    </Button>
                  </DialogClose>
                  <Button
                    type="button"
                    variant="danger"
                    loading={busy}
                    disabled={busy || password.length === 0}
                    onClick={() => {
                      void deleteAccount();
                    }}
                  >
                    Delete account
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>

          <Callout tone="warning" title="If you host a room">
            Rooms you host stay open until everyone leaves. When the account is purged, any room
            still running is handed to another participant or closed.
          </Callout>
        </div>
      </CardBody>
    </Card>
  );
}
