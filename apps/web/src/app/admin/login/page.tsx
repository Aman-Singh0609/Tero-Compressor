'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ApiError, authApi } from '@/lib/api';
import { friendlyError } from '@/lib/format';
import { Wordmark } from '@/components/Wordmark';
import { Button, Card, Input, Label, Notice } from '@/components/ui/primitives';

export default function AdminLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await authApi.login(email, password);
      router.replace('/admin');
    } catch (err) {
      setError(err instanceof ApiError ? friendlyError(err.code, err.message) : friendlyError('INTERNAL_ERROR'));
      setBusy(false);
    }
  };

  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex justify-center">
          <Wordmark />
        </div>
        <Card className="p-6">
          <h1 className="text-lg font-semibold text-ink">Admin sign in</h1>
          <p className="mt-1 mb-5 text-sm text-muted">Only the family administrator can open this area.</p>
          <form onSubmit={submit} className="space-y-4" noValidate>
            <div>
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            {error && <Notice tone="danger">{error}</Notice>}
            <Button type="submit" className="w-full" loading={busy} disabled={!email || !password}>
              Sign in
            </Button>
          </form>
        </Card>
      </div>
    </main>
  );
}
