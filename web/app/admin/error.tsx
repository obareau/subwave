'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card } from '@/components/admin/ui';
import { Button } from '@/components/ui/button';
import { V3Alert } from '@/components/ui/alert';

// Admin-scoped error boundary, nested inside app/admin/layout.tsx so a throwing
// panel leaves AdminShell's chrome (nav, sign-in state) mounted. Without this
// file the throw bubbles to app/error.tsx and takes the console down to the
// marketing-styled page, losing the nav the operator needs.
//
// Panels handle their own fetch failures inline, so what reaches this boundary
// is a render-time throw and the copy says so.
//
// `reset()` re-renders without re-fetching and is usually enough (panels fetch
// on mount); `router.refresh()` is included so a stale RSC payload can't pin the
// error in place.

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    console.error('[subwave] admin panel error', error.digest ?? '', error);
  }, [error]);

  return (
    <Card>
      <V3Alert tone="error" title="Panel failed to render">
        <p>
          This panel threw while rendering. Other panels are unaffected — use the nav to
          move on, or retry below.
        </p>
        {error.digest ? (
          <p className="mt-2">
            Reference <code>{error.digest}</code>.
          </p>
        ) : null}
        {error.message ? (
          <p className="mt-2 break-words opacity-80">{error.message}</p>
        ) : null}
      </V3Alert>
      <div className="mt-3">
        <Button
          variant="accent"
          size="sm"
          onClick={() => {
            // Re-run the server render AND clear the boundary: reset alone
            // re-renders the same failed tree.
            setRetrying(true);
            router.refresh();
            reset();
          }}
          disabled={retrying}
        >
          {retrying ? 'Retrying…' : 'Retry panel'}
        </Button>
      </div>
    </Card>
  );
}
