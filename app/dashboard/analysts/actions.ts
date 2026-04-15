'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/admin';

const createSchema = z.object({
  uw_analyst_id: z.string().trim().min(1, 'UW analyst ID is required'),
  name: z.string().trim().min(1, 'Name is required'),
  firm: z.string().trim().min(1, 'Firm is required'),
  tier: z.coerce.number().int().min(1).max(3),
  confidence_score: z.coerce.number().int().min(1).max(10),
  sectors: z
    .string()
    .optional()
    .transform((s) =>
      s
        ? s
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean)
        : []
    ),
  notes: z
    .string()
    .optional()
    .transform((s) => (s && s.trim().length > 0 ? s.trim() : null)),
});

export type CreateAnalystState = {
  error?: string;
  fieldErrors?: Record<string, string[] | undefined>;
};

export async function createAnalyst(
  _prev: CreateAnalystState,
  fd: FormData
): Promise<CreateAnalystState> {
  const parsed = createSchema.safeParse({
    uw_analyst_id: fd.get('uw_analyst_id'),
    name: fd.get('name'),
    firm: fd.get('firm'),
    tier: fd.get('tier'),
    confidence_score: fd.get('confidence_score'),
    sectors: fd.get('sectors'),
    notes: fd.get('notes'),
  });

  if (!parsed.success) {
    return {
      error: 'Validation failed',
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  const supabase = createAdminClient();
  const { error } = await supabase.from('trusted_analysts').insert({
    uw_analyst_id: parsed.data.uw_analyst_id,
    name: parsed.data.name,
    firm: parsed.data.firm,
    tier: parsed.data.tier,
    confidence_score: parsed.data.confidence_score,
    sectors: parsed.data.sectors,
    notes: parsed.data.notes,
    active: true,
  });

  if (error) {
    return { error: error.message };
  }

  revalidatePath('/dashboard/analysts');
  return {};
}

export async function deactivateAnalyst(id: string): Promise<{ error?: string }> {
  const supabase = createAdminClient();
  const { error } = await supabase
    .from('trusted_analysts')
    .update({ active: false })
    .eq('id', id);
  if (error) return { error: error.message };
  revalidatePath('/dashboard/analysts');
  return {};
}

export async function reactivateAnalyst(id: string): Promise<{ error?: string }> {
  const supabase = createAdminClient();
  const { error } = await supabase
    .from('trusted_analysts')
    .update({ active: true })
    .eq('id', id);
  if (error) return { error: error.message };
  revalidatePath('/dashboard/analysts');
  return {};
}
