'use client';

/**
 * Change password (PLAN.md feature A9, §11.1).
 *
 * Ends with a new recovery code on screen, because the server rotates it as part
 * of the change. That is not an extra step for the sake of it: the old code was
 * a live key to this account, and a password change is exactly when you want the
 * old key to stop working.
 */
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { MIN_PASSWORD_LENGTH, Schemas } from '@syncstudy/shared';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { PasswordInput } from '@/components/auth/password-input';
import { RecoveryCodePanel } from '@/components/auth/recovery-code-panel';
import { api, fieldsOf, messageOf } from '@/lib/api';

interface ChangePasswordResult {
  recoveryCode: string;
  sessionsEnded: number;
}

export function ChangePasswordForm() {
  const [formError, setFormError] = useState<string | null>(null);
  const [result, setResult] = useState<ChangePasswordResult | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<Schemas.ChangePasswordInput>({
    resolver: zodResolver(Schemas.ChangePasswordInput),
    defaultValues: { currentPassword: '', newPassword: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    setResult(null);
    try {
      const changed = await api.post<ChangePasswordResult>('/api/auth/change-password', values);
      setResult(changed);
      reset({ currentPassword: '', newPassword: '' });
    } catch (error) {
      const fields = fieldsOf(error);
      let placed = false;
      for (const key of ['currentPassword', 'newPassword'] as const) {
        const message = fields[key];
        if (message !== undefined) {
          setError(key, { type: 'server', message });
          placed = true;
        }
      }
      if (!placed) setFormError(messageOf(error));
    }
  });

  return (
    <Card>
      <CardHeader
        title="Password"
        description="Changing it signs you out on every other device and issues a new recovery code."
      />
      <CardBody>
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          {formError !== null ? <Callout tone="danger">{formError}</Callout> : null}

          {result !== null ? (
            <div className="flex flex-col gap-4">
              <Callout tone="success" title="Password changed">
                {result.sessionsEnded === 0
                  ? 'You were not signed in anywhere else.'
                  : `${result.sessionsEnded} other ${result.sessionsEnded === 1 ? 'session was' : 'sessions were'} signed out.`}
              </Callout>
              <RecoveryCodePanel code={result.recoveryCode} />
            </div>
          ) : null}

          <Field
            label="Current password"
            htmlFor="current-password"
            error={errors.currentPassword?.message}
          >
            <PasswordInput
              id="current-password"
              autoComplete="current-password"
              invalid={errors.currentPassword !== undefined}
              {...register('currentPassword')}
            />
          </Field>

          <Field
            label="New password"
            htmlFor="new-password"
            hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
            error={errors.newPassword?.message}
          >
            <PasswordInput
              id="new-password"
              autoComplete="new-password"
              invalid={errors.newPassword !== undefined}
              {...register('newPassword')}
            />
          </Field>

          <div className="flex justify-end">
            <Button type="submit" variant="primary" loading={isSubmitting} disabled={isSubmitting}>
              Change password
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
