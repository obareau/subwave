// Body of every `loading.tsx` on the public pages. The segment layouts already
// supply the chrome and loading.tsx nests inside its layout, so this renders the
// article body only.
//
// The public pages are `force-dynamic`, and a dynamic route with no loading
// boundary has nothing for Next to prerender into a prefetch: measured on a
// production build, /news came back as 183 bytes with `null` where the page
// segment goes, so clicking the link still blocked on a full round trip. A
// loading.tsx gives the prefetch something real to cache.
//
// Server components: no state, nothing to hydrate.

function Line({ className }: { className?: string }) {
  return <span className={`bs-skeleton bs-skeleton-line ${className ?? ''}`} />;
}

function HeroSkeleton() {
  return (
    <header className="bs-news-hero">
      <span className="bs-skeleton bs-skeleton-eyebrow" />
      <span className="bs-skeleton bs-skeleton-headline" />
      <Line />
      <Line className="bs-skeleton-line-wide" />
    </header>
  );
}

/** `catalog` mirrors the community index pages; `article` a prose page. */
export default function BroadsheetPageSkeleton({
  variant = 'catalog',
  cards = 6,
}: {
  variant?: 'catalog' | 'article';
  cards?: number;
}) {
  return (
    <article aria-busy="true">
      <HeroSkeleton />
      {variant === 'catalog' ? (
        <>
          <p className="bs-stat-strip" role="status" aria-label="Loading">
            <span className="bs-skeleton bs-skeleton-stat" />
          </p>
          <ul className="bs-stations-grid">
            {Array.from({ length: cards }, (_, i) => (
              <li key={i} className="bs-skeleton-card" aria-hidden="true">
                <span className="bs-skeleton bs-skeleton-line-title" />
                <Line />
                <Line className="bs-skeleton-line-wide" />
                <Line className="bs-skeleton-line-short" />
              </li>
            ))}
          </ul>
        </>
      ) : (
        <div className="bs-skeleton-prose" role="status" aria-label="Loading">
          {Array.from({ length: 10 }, (_, i) => (
            <Line key={i} className={i % 4 === 3 ? 'bs-skeleton-line-short' : undefined} />
          ))}
        </div>
      )}
    </article>
  );
}
