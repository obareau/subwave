// App-wide Suspense fallback. Most top-level routes are force-dynamic, so
// without a loading boundary the shell blanks while the server render + fetch is
// in flight. This is the nearest fallback for any segment without its own
// loading.tsx, and announces itself to assistive tech via role="status".
export default function RootLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg text-ink">
      <div role="status" className="flex items-center gap-2 text-sm text-muted">
        <span
          aria-hidden
          className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-muted border-t-transparent"
        />
        Loading…
      </div>
    </div>
  );
}
