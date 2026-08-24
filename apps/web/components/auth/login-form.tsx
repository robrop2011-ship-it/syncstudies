'use client';

/**
 * Sign in (PLAN.md §2.2, §11.1).
 *
 * The server answers with one message for both "no such username" and "wrong
 * password", so this form has one place to show it: a block above the fields,
 * inline, never a toast (§12.5).
 */
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { HANDLE_MAX, Schemas } from '@syncstudy/shared';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/auth/password-input';
import { api, fieldsOf, messageOf } from '@/lib/api';

export function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [formError, setFormError] = useState<string | null>(null);
  const [navigating, setNavigating] = useState(false);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<Schemas.LoginInput>({
    resolver: zodResolver(Schemas.LoginInput),
    defaultValues: { handle: '', password: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await api.post('/api/auth/login', values);
      setNavigating(true);
      router.push(next);
      router.refresh();
    } catch (error) {
      const fields = fieldsOf(error);
      let placed = false;
      for (const key of ['handle', 'password'] as const) {
        const message = fields[key];
        if (message !== undefined) {
          setError(key, { type: 'server', message });
          placed = true;
        }
      }
      if (!placed) setFormError(messageOf(error));
    }
  });

  const busy = isSubmitting || navigating;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1.5">
        <h1 className="text-xl font-semibold tracking-[-0.01em] text-primary">
          Sign in
        </h1>
        <p className="text-sm leading-5 text-secondary">
          Welcome back. Pick up where the room left off.
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

        <Field label="Password" htmlFor="password" error={errors.password?.message}>
          <PasswordInput
            id="password"
            autoComplete="current-password"
            invalid={errors.password !== undefined}
            {...register('password')}
          />
        </Field>

        <Button type="submit" variant="primary" loading={busy} disabled={busy}>
          Sign in
        </Button>
      </form>

      <div className="flex flex-col gap-1.5 text-13 text-secondary">
        <Link
          href="/recover"
          className="rounded-sm text-accent underline-offset-2 hover:underline"
        >
          Forgot your password? Use your recovery code
        </Link>
        <p>
          No account yet?{' '}
          <Link
            href={`/signup?next=${encodeURIComponent(next)}`}
            className="rounded-sm text-accent underline-offset-2 hover:underline"
          >
            Create one
          </Link>
        </p>
      </div>
    </div>
  );
}
