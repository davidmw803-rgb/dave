/**
 * Service-role Supabase client. Bypasses RLS entirely.
 *
 * SERVER-ONLY. Never import from a client component. The service_role key
 * grants full database access — if it ever reached the browser the entire
 * security model collapses.
 *
 * Safe call sites: Server Components, Server Actions, Route Handlers, and
 * background jobs (cron endpoints, edge functions).
 */

import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database.types';

let cached: ReturnType<typeof createClient<Database>> | null = null;

export function createAdminClient() {
  if (cached) return cached;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL is not set');
  }
  if (!serviceRoleKey) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY is not set — required for server-side DB access under RLS deny-all'
    );
  }

  cached = createClient<Database>(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  return cached;
}
