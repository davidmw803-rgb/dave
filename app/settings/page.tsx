import { SettingsClient } from '@/components/settings/settings-client';
import { SETTING_DEFS, getSettingStatuses } from '@/lib/settings/store';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function SettingsPage() {
  const { statuses, error } = await getSettingStatuses();
  return <SettingsClient defs={SETTING_DEFS} initialStatuses={statuses} loadError={error} />;
}
