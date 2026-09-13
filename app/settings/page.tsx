import { SettingsClient } from '@/components/settings/settings-client';
import { PasswordCard } from '@/components/settings/password-card';
import { SETTING_DEFS, getSettingStatuses } from '@/lib/settings/store';
import { passwordSource } from '@/lib/auth/password';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function SettingsPage() {
  const [{ statuses, error }, source] = await Promise.all([
    getSettingStatuses(),
    passwordSource(),
  ]);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PasswordCard initialSource={source} />
      <SettingsClient defs={SETTING_DEFS} initialStatuses={statuses} loadError={error} />
    </div>
  );
}
