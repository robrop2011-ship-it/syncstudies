'use client';

/**
 * Account recovery (PLAN.md Amendment A1, feature A9).
 *
 * There is no email, so this form is the entire "forgot password" story. It ends
 * on a new recovery code, because the one just used is spent — leaving someone
 * recovered but without a code would put them one forgotten password away from
 * losing the account for good.
 */
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { HANDLE_MAX, MIN_PASSWORD_LENGTH, Schemas } from '@syncstudy/shared';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/auth/password-input';
import { RecoveryCodePanel } from '@/components/auth/recovery-code-panel';
import { api, fieldsOf, messageOf } from '@/lib/api';

interface RecoverResult {
  recoveryCode: string;
}

export function RecoverForm({ next }: { next: string }) {
  const router = useRouter();
  const [formError, setFormError] = useState<string | null>(null);
  const [newCode, setNewCode] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<Schemas.RecoverInput>({
    resolver: zodResolver(Schemas.RecoverInput),
    defaultValues: { handle: '', recoveryCode: '', newPassword: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      const result = await api.post<RecoverResult>('/api/auth/recover', values);
      setNewCode(result.recoveryCode);
    } catch (error) {
      const fields = fieldsOf(error);
      let placed = false;
      for (const key of ['handle', 'recoveryCode', 'newPassword'] as const) {
        const message = fields[key];
        if (message !== undefined) {
          setError(key, { type: 'server', message });
          placed = true;
        }
      }
      if (!placed) setFormError(messageOf(error));
    }
  });

  if (newCode !== null) {
    return (
      <div className="flex flex-col gap-6">
        <header className="flex flex-col gap-1.5">
          <h1 className="text-xl font-semibold tracking-[-0.01em] text-primary">
            Password changed
          </h1>
          <p className="text-sm leading-5 text-secondary">
            You are signed in on this device. Every other session has been signed out, and the code
            you just used no longer works. Here is its replacement.
          </p>
        </header>

        <RecoveryCodePanel
          code={newCode}
          busy={leaving}
          continueLabel="Continue to SyncStudy"
          onContinue={() => {
            setLeaving(true);
            router.push(next);
            router.refresh();
          }}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1.5">
        <h1 className="text-xl font-semibold tracking-[-0.01em] text-primary">
          Use your recovery code
        </h1>
        <p className="text-sm leading-5 text-secondary">
          The 24-character code you were given when you signed up. It works once.
        </p>
      </header>

      {formError !== null ? <Callout tone="danger">{formError}</Callout> : null}

      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        <Field label="Username" htmlFor="handle" error={errors.handle?.message}>
          <Input
            id="handle"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            maxLength={HANDLE_MAX}
            invalid={errors.handle !== undefined}
            {...register('handle')}
          />
        </Field>

        <Field
          label="Recovery code"
          htmlFor="recoveryCode"
          hint="Dashes and capitals do not matter."
          error={errors.recoveryCode?.message}
        >
          <Input
            id="recoveryCode"
            className="font-mono tracking-[0.04em]"
            autoComplete="one-time-code"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
            invalid={errors.recoveryCode !== undefined}
            {...register('recoveryCode')}
          />
        </Field>

        <Field
          label="New password"
          htmlFor="newPassword"
          hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
          error={errors.newPassword?.message}
        >
          <PasswordInput
            id="newPassword"
            autoComplete="new-password"
            invalid={errors.newPassword !== undefined}
            {...register('newPassword')}
          />
        </Field>

        <Button type="submit" variant="primary" loading={isSubmitting} disabled={isSubmitting}>
          Set new password
        </Button>
      </form>

      <Callout tone="info" title="Lost the code too?">
        There is no email address on a SyncStudy account, which means there is no reset link and no
        way for us to prove an account is yours. If both the password and the code are gone, the
        account cannot be recovered. That is the cost of collecting nothing about you.
      </Callout>

      <p className="text-13 text-secondary">
        <Link
          href="/login"
          className="rounded-sm text-accent underline-offset-2 hover:underline"
        >
          Back to sign in
        </Link>
      </p>
    </div>
  );
}
