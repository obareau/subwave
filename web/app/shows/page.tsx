import { Suspense } from 'react';
import { AnimatedLink } from '@/components/ui/animated-link';
import CommunityShowCard from '@/components/shows/CommunityShowCard';
import { CatalogGridSkeleton, CatalogStatSkeleton } from '@/components/ui/catalog-skeleton';
import { fetchCommunityShows, type CommunityShow } from '@/lib/communityShows';
import { pageMeta } from '@/lib/seo';
import { showSubmitUrl } from '@/lib/repo';

export const metadata = pageMeta({
  title: 'SUB/WAVE — Community Shows',
  description:
    'The community show catalog: show templates other operators built and sent in, with the topic brief and music filters that steer each one. Install any from your own admin console.',
  path: '/shows',
});

// The catalog is baked into the controller image and refreshed on update, so
// read it live from the local controller at request time rather than at build.
export const dynamic = 'force-dynamic';

// Submission opens a GitHub Issue Form; a workflow turns it into a one-file PR.
// Mirrors the /skills + /personas share flows.
const SUBMIT_URL = showSubmitUrl();
const DOCS_URL = 'https://github.com/perminder-klair/subwave/blob/main/docs/community.md';

// Each region takes the in-flight promise rather than calling
// fetchCommunityShows() itself, so the page issues exactly one request however
// many boundaries read it. Framework-level fetch memoisation can't help here:
// fetchCommunityShows opts out with `cache: 'no-store'`.

async function ShowsStat({ shows }: { shows: Promise<CommunityShow[]> }) {
  const count = (await shows).length;
  if (count === 0) return null;
  return (
    <p className="bs-stat-strip">
      <span>
        <strong>{count}</strong> {count === 1 ? 'show' : 'shows'} in the catalog
      </span>
    </p>
  );
}

async function ShowsGrid({ shows }: { shows: Promise<CommunityShow[]> }) {
  const list = await shows;
  if (list.length === 0) {
    return (
      <p className="bs-news-empty">
        Nothing in the show catalog yet, or this station hasn&rsquo;t caught up with it. Be the
        first to{' '}
        <AnimatedLink href={SUBMIT_URL} className="bs-link">
          share a show
        </AnimatedLink>
        .
      </p>
    );
  }
  return (
    <ul className="bs-stations-grid">
      {list.map((s) => (
        <CommunityShowCard key={s.slug} show={s} />
      ))}
    </ul>
  );
}

export default function CommunityShowsIndex() {
  // Started, not awaited: keeping this component synchronous is what lets the
  // hero, CTA and closing note flush while the catalog streams in behind the
  // boundaries. fetchCommunityShows resolves to [] on any failure, so holding
  // the promise unawaited can't produce an unhandled rejection.
  const shows = fetchCommunityShows();

  return (
    <article>
      <header className="bs-news-hero">
        <p className="bs-eyebrow">THE PROGRAMME GUIDE</p>
        <h1>Community Shows.</h1>
        <p>
          A show is a slot on the grid: a topic brief for the DJ, plus the music filters that
          decide what plays under it. Produced mode airs it as a full episode, with an intro
          at the top, a feature every hour and a sign-off at the end. Banter puts guest
          co-hosts on the mic together. Every one below came from another operator, and they
          ship with every station.
        </p>
      </header>

      <Suspense fallback={<CatalogStatSkeleton />}>
        <ShowsStat shows={shows} />
      </Suspense>

      <div className="bs-station-cta">
        <p className="bs-station-cta-copy">Built a show that works? Add it to the guide.</p>
        <AnimatedLink href={SUBMIT_URL} variant="arrow" className="bs-station-cta-link">
          Share a show
        </AnimatedLink>
        <AnimatedLink href={DOCS_URL} className="bs-station-cta-help">
          How it works
        </AnimatedLink>
      </div>

      <Suspense fallback={<CatalogGridSkeleton />}>
        <ShowsGrid shows={shows} />
      </Suspense>

      <p className="bs-stations-report">
        To install, open <strong>Shows → Community</strong> in your station&rsquo;s admin and hit{' '}
        <strong>Install</strong>. Every show lands unscheduled, so you pick the persona who
        hosts it and the hours it runs.
      </p>
    </article>
  );
}
