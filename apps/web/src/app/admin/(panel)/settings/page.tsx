'use client';

import { adminApi } from '@/lib/api';
import { friendlyError } from '@/lib/format';
import { useResource } from '@/lib/hooks';
import { DetailList, PageHeader, Section } from '@/components/admin/common';
import { ErrorState, Skeleton } from '@/components/ui/primitives';

export default function SettingsPage() {
  const { data: s, error, loading, refetch } = useResource(() => adminApi.settings(), []);
  if (error && !s) return <ErrorState message={friendlyError(error.code, error.message)} onRetry={refetch} />;
  return (
    <>
      <PageHeader
        title="Settings"
        description="Effective configuration. These values come from the server’s environment file; edit it and restart to change them."
      />
      <Section title="Configuration" className="max-w-2xl">
        <div className="px-4 py-2 sm:px-5">
          {loading || !s ? (
            <Skeleton className="my-3 h-40" />
          ) : (
            <DetailList
              rows={[
                ['Environment', s.environment],
                ['File storage', s.storageDriver === 'mysql' ? 'MySQL database' : 'Local disk'],
                ['File retention', `${s.retentionDays} days`],
                ['Cleanup interval', `${s.cleanupIntervalMinutes} minutes`],
                ['Max upload size', `${s.maxUploadMb} MB`],
                ['Max vault file size', `${s.vaultMaxMb} MB`],
                ['Parallel jobs', String(s.jobConcurrency)],
                ['Video time limit', `${s.videoTimeoutMinutes} minutes`],
                ['Admin session length', `${s.sessionTtlHours} hours`],
              ]}
            />
          )}
        </div>
      </Section>
    </>
  );
}
