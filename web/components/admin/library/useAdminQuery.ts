'use client';

import {
  useMutation, useQuery, useQueryClient,
  type QueryClient, type UseMutationResult, type UseQueryResult,
} from '@tanstack/react-query';
import { errorMessage, notify } from '../../../lib/notify';
import { useLibrary } from './LibraryContext';
import { useQueryErrorToast } from './queries';

// The two hooks that bind TanStack to the page's ONE adminFetch. Split from
// queries.ts so the key factory and the cache helpers stay importable from
// LibraryContext without an import cycle.

export type AdminFetch = (path: string, init?: RequestInit) => Promise<Response>;

export interface AdminQueryOpts<T> {
  key: readonly unknown[];
  path: string | (() => string);
  enabled?: boolean;
  staleTime?: number;
  refetchInterval?: number | false;
  /** Toast the error. Omit for the polls that deliberately fail silently. */
  toastOnError?: boolean;
  /**
   * Normalise the raw response into the shape callers use. Runs inside the
   * queryFn, NOT as `select`, deliberately: `select` transforms only what an
   * observer sees, while setQueriesData writes the RAW cached value — so a
   * `select` that unwrapped `{ results: [...] }` would leave patchAllRows
   * staring at a shape no component ever names. Normalising here makes the
   * cache the one true shape, which is what lets patchAllRows enumerate three
   * shapes rather than one per endpoint.
   */
  parse?: (raw: unknown) => T;
}

export function useAdminQuery<T>({
  key, path, enabled = true, staleTime, refetchInterval, toastOnError = false, parse,
}: AdminQueryOpts<T>): UseQueryResult<T> {
  const { adminFetch, ready } = useLibrary();
  const q = useQuery({
    queryKey: key,
    // adminFetch is NOT in the key: its identity changes whenever auth or
    // needsAuth flips (lib/adminAuth.ts), which would evict the whole cache on
    // a token refresh. It is read fresh inside the fn instead.
    queryFn: async () => {
      const p = typeof path === 'function' ? path() : path;
      const r = await adminFetch(p);
      if (!r.ok) {
        const j = await r.json().catch(() => ({})) as { error?: string };
        throw new Error(j.error || `${p} failed (${r.status})`);
      }
      const raw = await r.json() as unknown;
      return (parse ? parse(raw) : raw) as T;
    },
    enabled: enabled && ready,
    // Spread only when set. An explicit `staleTime: undefined` is a KEY on the
    // options object, and defaulting is a spread — so passing it through
    // unconditionally overwrote the client's 30s default with undefined (= 0)
    // and every list refetched on every remount, which is exactly the cache
    // reuse this change exists to get.
    ...(staleTime !== undefined ? { staleTime } : {}),
    ...(refetchInterval !== undefined ? { refetchInterval } : {}),
  });
  useQueryErrorToast(q.error, toastOnError);
  return q;
}

export interface AdminMutationOpts<TVars, TData> {
  request: (vars: TVars, fetcher: AdminFetch) => Promise<TData>;
  onDone?: (data: TData, vars: TVars, qc: QueryClient) => void | Promise<void>;
}

export function useAdminMutation<TVars, TData>({
  request, onDone,
}: AdminMutationOpts<TVars, TData>): UseMutationResult<TData, Error, TVars> {
  const { adminFetch } = useLibrary();
  const qc = useQueryClient();
  return useMutation<TData, Error, TVars>({
    mutationFn: (vars: TVars) => request(vars, adminFetch),
    onSuccess: (data, vars) => onDone?.(data, vars, qc),
    // Every hand-rolled predecessor ended in `catch (err) { notify.err(...) }`,
    // so the toast lives here once rather than at eleven call sites. Mutations
    // that need bespoke recovery (the like toggle's rollback) do it in their own
    // wrapper — this only replaces the uniform half.
    onError: err => { notify.err(errorMessage(err)); },
  });
}
