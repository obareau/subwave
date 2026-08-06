// Suspense fallback for the force-dynamic /landing broadsheet. The page awaits
// the showcase-station catalog before it can return, so without this boundary
// the whole app shell blanks while that request is in flight. Announces itself
// to assistive tech via role="status".
export default function LandingLoading() {
  return (
    <div className="min-h-screen bg-bg text-ink">
      <main className="bs-paper" aria-busy="true">
        <div className="bs-rule-double" />
        <div role="status" className="px-4 py-24 text-center text-sm text-muted">
          Loading the broadsheet…
        </div>
      </main>
    </div>
  );
}
