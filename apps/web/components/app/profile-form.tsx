'use client';

/**
 * Profile settings — display name, bio, school (PLAN.md feature A4).
 *
 * No zod resolver on this one. `UpdateProfileInput` models "leave it alone"
 * (absent) and "clear it" (null) for bio and school, and a text input has
 * neither of those states — it has "". So the form works in strings, converts ""
 * to null on the way out, and lets the server's field errors do the validating.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { MAX_BIO, MAX_DISPLAY_NAME, MAX_SCHOOL } from '@syncstudy/shared';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { api, fieldsOf, messageOf } from '@/lib/api';

export interface ProfileFormProps {
  handle: string;
  displayName: string;
  bio: string | null;
  school: string | null;
}

interface ProfileValues {
  displayName: string;
  bio: string;
  school: string;
}

export function ProfileForm(props: ProfileFormProps) {
  const router = useRouter();
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const {
    register,
    handleSubmit,
    watch,
    setError,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<ProfileValues>({
    defaultValues: {
      displayName: props.displayName,
      bio: props.bio ?? '',
      school: props.school ?? '',
    },
  });

  const bioLength = (watch('bio') ?? '').length;

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    setSaved(false);
    try {
      await api.patch('/api/me', {
        displayName: values.displayName.trim(),
        bio: values.bio.trim().length === 0 ? null : values.bio.trim(),
        school: values.school.trim().length === 0 ? null : values.school.trim(),
      });
      setSaved(true);
      // The header renders the display name, so it has to re-read.
      router.refresh();
    } catch (error) {
      const fields = fieldsOf(error);
      let placed = false;
      for (const key of ['displayName', 'bio', 'school'] as const) {
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
        title="Profile"
        description="What other people see when you join a room."
      />
      <CardBody>
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          {formError !== null ? <Callout tone="danger">{formError}</Callout> : null}
          {saved && !isDirty ? <Callout tone="success">Profile updated.</Callout> : null}

          <Field label="Username" htmlFor="profile-handle" hint="Usernames cannot be changed yet.">
            <Input id="profile-handle" value={props.handle} readOnly disabled />
          </Field>

          <Field
            label="Display name"
            htmlFor="profile-display-name"
            error={errors.displayName?.message}
          >
            <Input
              id="profile-display-name"
              maxLength={MAX_DISPLAY_NAME}
              autoComplete="nickname"
              invalid={errors.displayName !== undefined}
              {...register('displayName')}
            />
          </Field>

          <div className="flex flex-col gap-1">
            <Field label="Bio" htmlFor="profile-bio" optional error={errors.bio?.message}>
              <Textarea
                id="profile-bio"
                rows={3}
                maxLength={MAX_BIO}
                placeholder="Second year, mostly organic chemistry."
                invalid={errors.bio !== undefined}
                {...register('bio')}
              />
            </Field>
            <p className="text-right text-xs text-tertiary">
              {bioLength}/{MAX_BIO}
            </p>
          </div>

          <Field
            label="School"
            htmlFor="profile-school"
            optional
            hint="Free text. There is no institution list and nothing is verified."
            error={errors.school?.message}
          >
            <Input
              id="profile-school"
              maxLength={MAX_SCHOOL}
              invalid={errors.school !== undefined}
              {...register('school')}
            />
          </Field>

          <div className="flex justify-end">
            <Button type="submit" variant="primary" loading={isSubmitting} disabled={isSubmitting}>
              Save changes
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
