'use client';

import type { ReactNode } from 'react';
import { V3Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

/* Shared "a fetch failed" panel for the admin console, on V3Alert
   (tone="error") with an optional Retry — the same shape the admin error
   boundary (app/admin/error.tsx) uses. `error` is the raw controller message;
   panels own their own retry logic. */
export interface ErrorStateProps {
  /** Defaults to the controller-unreachable framing. */
  title?: ReactNode;
  children?: ReactNode;
  /** Raw controller message, shown de-emphasised. */
  error?: ReactNode;
  onRetry?: () => void;
  retrying?: boolean;
  retryLabel?: string;
}

export function ErrorState({
  title = "Can't reach the controller",
  children,
  error,
  onRetry,
  retrying,
  retryLabel = 'Retry',
}: ErrorStateProps) {
  return (
    <div className="grid gap-3">
      <V3Alert tone="error" title={title}>
        {children ?? (
          <p>
            Something went wrong talking to the controller. It may be restarting — give it a
            moment and retry.
          </p>
        )}
        {error ? <p className="mt-2 break-words opacity-80">{error}</p> : null}
      </V3Alert>
      {onRetry && (
        <div>
          <Button variant="accent" size="sm" onClick={onRetry} disabled={retrying}>
            {retrying ? 'Retrying…' : retryLabel}
          </Button>
        </div>
      )}
    </div>
  );
}
