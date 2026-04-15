'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { COOKIE_NAME, MAX_AGE_SECONDS, signSession } from '@/lib/auth/session';

export type LoginState = { error?: string };

export async function login(
  _prev: LoginState,
  fd: FormData
): Promise<LoginState> {
  const submitted = String(fd.get('password') ?? '');
  const expected = process.env.APP_PASSWORD ?? '';
  const from = String(fd.get('from') ?? '/dashboard/analysts');

  if (!expected) {
    return { error: 'APP_PASSWORD is not set on the server.' };
  }

  if (submitted.length === 0) {
    return { error: 'Password is required.' };
  }

  // Constant-time string compare to avoid timing attacks on the password itself.
  if (submitted.length !== expected.length) {
    return { error: 'Incorrect password.' };
  }
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= submitted.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  if (mismatch !== 0) {
    return { error: 'Incorrect password.' };
  }

  const token = await signSession();
  cookies().set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  });

  // Only allow same-origin relative paths for `from`, never absolute URLs.
  const target =
    from.startsWith('/') && !from.startsWith('//') ? from : '/dashboard/analysts';
  redirect(target);
}

export async function logout() {
  cookies().delete(COOKIE_NAME);
  redirect('/login');
}
