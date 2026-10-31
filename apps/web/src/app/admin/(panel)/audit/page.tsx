'use client';

import { useState } from 'react';
import { adminApi } from '@/lib/api';
import { formatDate, friendlyError } from '@/lib/format';
import { useResource } from '@/lib/hooks';
import { PageHeader, Pager, SelectFilter, TableSkeleton, Th, Toolbar } from '@/components/admin/common';
import { Badge, Card, EmptyState, ErrorState } from '@/components/ui/primitives';

const ACTIONS = [
  'ADMIN_LOGIN',
  'ADMIN_LOGIN_FAILED',
  'ADMIN_LOGOUT',
  'FILE_VIEW',
  'FILE_DOWNLOAD',
  'FILE_DELETE',
  'VAULT_UPLOAD',
  'VAULT_VIEW',
  'VAULT_DOWNLOAD',
  'VAULT_UPDATE',
  'VAULT_REPLACE',
  'VAULT_DELETE',
  'JOB_VIEW',
];

export default function AuditPage() {
  const [action, setAction] = useState('');
  const [page, setPage] = useState(1);
  const list = useResource(() => adminApi.audit({ page, limit: 50, action }), [page, action]);
  const rows = list.data?.items ?? [];

  return (
    <>
      <PageHeader
        title="Audit logs"
        description="Who did what in the admin area. Passwords and file contents are never recorded."
      />
      <Card>
        <Toolbar>
          <SelectFilter
            label="Action"
            value={action}
            onChange={(v) => {
              setAction(v);
              setPage(1);
            }}
            options={[
              ['', 'All actions'],
              ...ACTIONS.map((a): [string, string] => [a, a.replace(/_/g, ' ').toLowerCase()]),
            ]}
          />
        </Toolbar>
        {list.error && !list.data ? (
          <ErrorState message={friendlyError(list.error.code, list.error.message)} onRetry={list.refetch} />
        ) : list.loading && !list.data ? (
          <TableSkeleton />
        ) : rows.length === 0 ? (
          <EmptyState title="No audit entries" hint="Admin actions appear here as they happen." />
        ) : (
          <div className={list.loading ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead className="border-b border-line bg-surface-2/60">
                  <tr>
                    <Th>When</Th>
                    <Th>Action</Th>
                    <Th className="hidden md:table-cell">Admin</Th>
                    <Th>Target</Th>
                    <Th className="hidden lg:table-cell">IP</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td className="px-4 py-3 whitespace-nowrap text-muted">{formatDate(r.createdAt)}</td>
                      <td className="px-4 py-3">
                        <Badge
                          tone={
                            r.action === 'ADMIN_LOGIN_FAILED'
                              ? 'danger'
                              : r.action.endsWith('DELETE')
                                ? 'warn'
                                : 'neutral'
                          }
                        >
                          {r.action.replace(/_/g, ' ').toLowerCase()}
                        </Badge>
                      </td>
                      <td className="hidden px-4 py-3 text-muted md:table-cell">{r.admin?.email ?? '—'}</td>
                      <td className="max-w-[14rem] px-4 py-3 text-muted">
                        {r.entityType ? (
                          <span className="block truncate" title={r.entityId ?? ''}>
                            {r.entityType} {r.entityId?.slice(0, 8)}
                          </span>
                        ) : (
                          '—'
                        )}
                        {r.metadata && typeof r.metadata.name === 'string' && (
                          <span className="block truncate text-xs">{r.metadata.name}</span>
                        )}
                      </td>
                      <td className="hidden px-4 py-3 text-muted lg:table-cell">{r.ipAddress ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager pagination={list.data?.pagination} onPage={setPage} loading={list.loading} />
          </div>
        )}
      </Card>
    </>
  );
}
