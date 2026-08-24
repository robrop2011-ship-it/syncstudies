'use client';

/**
 * Signup (PLAN.md §2.1, §3.1, Amendment A1).
 *
 * Two steps, and the second one is not a formality: the account exists after
 * step one, but the recovery code shown in step two is the only thing standing
 * between a forgotten password and a lost account. It gets its own screen rather
 * than a banner on the dashboard that somebody scrolls past.
 */
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Check, X } from 'lucide-react';
import {
  HANDLE_MAX,
  HANDLE_MIN,
  MAX_DISPLAY_NAME,
  MIN_PASSWORD_LENGTH,
  MIN_SIGNUP_AGE,
  Schemas,
} from '@syncstudy/shared';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { NativeSelect } from '@/components/app/native-select';
import { PasswordInput } from '@/components/auth/password-input';
import { RecoveryCodePanel } from '@/components/auth/recovery-code-panel';
import { api, fieldsOf, messageOf } from '@/lib/api';

interface SignupResult {
  recoveryCode: string;
}

interface HandleAvailability {
  handle: string;
  available: boolean;
  message: string;
}

type AvailabilityState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; message: string }
  | { kind: 'unavailable'; message: string };

const HANDLE_DEBOUNCE_MS = 400;
const OLDEST_AGE = 100;

export function SignupForm({ next }: { next: string }) {
  const router = useRouter();
  const [formError, setFormError] = useState<string | null>(null);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [availability, setAvailability] = useState<AvailabilityState>({ kind: 'idle' });
  const latestCheck = useRef(0);

  const {
    register,
    handleSubmit,
    watch,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<Schemas.SignupInput>({
    resolver: zodResolver(Schemas.SignupInput),
    defaultValues: { handle: '', displayName: '', password: '' },
  });

  const handleValue = watch('handle');

  // Live availability. Handles are public, so the endpoint answers truthfully
  // (§11.1) and a taken username is caught here rather than on submit.
  useEffect(() => {
    const candidate = (handleValue ?? '').trim().toLowerCase();

    if (candidate.length === 0) {
      setAvailability({ kind: 'idle' });
      return;
    }
    if (candidate.length < HANDLE_MIN) {
      setAvailability({ kind: 'unavailable', message: `At least ${HANDLE_MIN} characters.` });
      return;
    }

    setAvailability({ kind: 'checking' });
    const requestId = latestCheck.current + 1;
    latestCheck.current = requestId;

    const timer = setTimeout(() => {
      void (async () => {
        try {
          const result = await api.get<HandleAvailability>(
            `/api/auth/handle-available?handle=${encodeURIComponent(candidate)}`,
          );
          // A slower earlier request must not overwrite a newer answer.
          if (latestCheck.current !== requestId) return;
          setAvailability(
            result.available
              ? { kind: 'available', message: result.message }
              : { kind: 'unavailable', message: result.message },
          );
        } catch (error) {
          if (latestCheck.current !== requestId) return;
          setAvailability({ kind: 'unavailable', message: messageOf(error) });
        }
      })();
    }, HANDLE_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [handleValue]);

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      const result = await api.post<SignupResult>('/api/auth/signup', values);
      setRecoveryCode(result.recoveryCode);
    } catch (error) {
      const fields = fieldsOf(error);
      let placed = false;
      for (const key of ['handle', 'displayName', 'password', 'birthYear'] as const) {
        const message = fields[key];
        if (message !== undefined) {
          setError(key, { type: 'server', message });
          placed = true;
        }
      }
      if (!placed) setFormError(messageOf(error));
    }
  });

  if (recoveryCode !== null) {
    return (
      <div className="flex flex-col gap-6">
        <header className="flex flex-col gap-1.5">
          <h1 className="text-xl font-semibold tracking-[-0.01em] text-primary">
            Your account is ready
          </h1>
          <p className="text-sm leading-5 text-secondary">
            One thing before you start studying.
          </p>
        </header>

        <RecoveryCodePanel
          code={recoveryCode}
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

  const currentYear = new Date().getUTCFullYear();
  const newestYear = currentYear - MIN_SIGNUP_AGE;
  const years: number[] = [];
  for (let year = newestYear; year >= currentYear - OLDEST_AGE; year -= 1) years.push(year);

  const rawBirthYearError = errors.birthYear?.message;
  const birthYearError =
    rawBirthYearError === undefined
      ? undefined
      : /nan|number/i.test(rawBirthYearError)
        ? 'Select your birth year.'
        : rawBirthYearError;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1.5">
        <h1 className="text-xl font-semibold tracking-[-0.01em] text-primary">
          Create your account
        </h1>
        <p className="text-sm leading-5 text-secondary">
          A username and a password. No email address, now or ever.
        </p>
      </header>

      {formError !== null ? <Callout tone="danger">{formError}</Callout> : null}

      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        <Field
          label="Display name"
          htmlFor="displayName"
          hint="What people see in a room. You can change it later."
          error={errors.displayName?.message}
        >
          <Input
            id="displayName"
            autoComplete="nickname"
            maxLength={MAX_DISPLAY_NAME}
            invalid={errors.displayName !== undefined}
            {...register('displayName')}
          />
        </Field>

        {/* The availability line sits outside the Field on purpose: Field wires
            aria-describedby onto a single child, and a second child would leave
            the error message unlinked from the input. */}
        <div className="flex flex-col gap-1.5">
          <Field label="Username" htmlFor="handle" error={errors.handle?.message}>
            <Input
              id="handle"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              maxLength={HANDLE_MAX}
              invalid={errors.handle !== undefined || availability.kind === 'unavailable'}
              {...register('handle')}
            />
          </Field>
          <AvailabilityLine state={availability} />
        </div>

        <Field
          label="Password"
          htmlFor="password"
          hint={`At least ${MIN_PASSWORD_LENGTH} characters. Length beats symbols.`}
          error={errors.password?.message}
        >
          <PasswordInput
            id="password"
            autoComplete="new-password"
            invalid={errors.password !== undefined}
            {...register('password')}
          />
        </Field>

        <Field
          label="Birth year"
          htmlFor="birthYear"
          hint="Used once, to check you are 13 or older, and to set safer defaults for under-18s. The year itself is not stored."
          error={birthYearError}
        >
          <NativeSelect
            id="birthYear"
            defaultValue=""
            invalid={birthYearError !== undefined}
            {...register('birthYear', { valueAsNumber: true })}
          >
            <option value="" disabled>
              Select a year
            </option>
            {years.map((year) => (
              <option key={year} value={year}>
                {year}
              </option>
            ))}
          </NativeSelect>
        </Field>

        <Button type="submit" variant="primary" loading={isSubmitting} disabled={isSubmitting}>
          Create account
        </Button>
      </form>

      <p className="text-13 text-secondary">
        Already have an account?{' '}
        <Link
          href={`/login?next=${encodeURIComponent(next)}`}
          className="rounded-sm text-accent underline-offset-2 hover:underline"
        >
          Sign in
        </Link>
      </p>
    </div>
  );
}

function AvailabilityLine({ state }: { state: AvailabilityState }) {
  if (state.kind === 'idle') return null;

  if (state.kind === 'checking') {
    return (
      <p className="flex items-center gap-1.5 text-13 text-tertiary">
        <Spinner size={14} />
        Checking availability
      </p>
    );
  }

  const available = state.kind === 'available';
  return (
    <p
      aria-live="polite"
      className={`flex items-center gap-1.5 text-13 ${
        available ? 'text-success' : 'text-danger'
      }`}
    >
      {available ? (
        <Check size={16} strokeWidth={1.5} aria-hidden="true" />
      ) : (
        <X size={16} strokeWidth={1.5} aria-hidden="true" />
      )}
      {state.message}
    </p>
  );
}
