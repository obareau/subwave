import { Suspense } from 'react';
import { AnimatedLink } from '@/components/ui/animated-link';
import { CatalogGridSkeleton, CatalogStatSkeleton } from '@/components/ui/catalog-skeleton';
import CommunityPersonaCard from '@/components/personas/CommunityPersonaCard';
import { fetchCommunityPersonas, type CommunityPersona } from '@/lib/communityPersonas';
import { pageMeta } from '@/lib/seo';
import { personaSubmitUrl } from '@/lib/repo';

export const metadata = pageMeta({
  title: 'SUB/WAVE — Community Personas',
  description:
    'The community persona catalog: DJ identities other operators wrote and sent in. Read their souls here, install them from your own admin console.',
  path: '/personas',
});

// The catalog is baked into the controller image and refreshed on update, so
// read it live from the local controller at request time rather than at build.
export const dynamic = 'force-dynamic';

// Submission opens a GitHub Issue Form in the community catalog repo; a workflow
// turns it into a one-file PR.
const SUBMIT_URL = personaSubmitUrl();

// Each region reads the one in-flight promise rather than calling the loader
// itself — see the note in app/shows/page.tsx.

async function PersonasStat({ personas }: { personas: Promise<CommunityPersona[]> }) {
  const count = (await personas).length;
  if (count === 0) return null;
  return (
    <p className="bs-stat-strip">
      <span>
        <strong>{count}</strong> {count === 1 ? 'persona' : 'personas'} in the catalog
      </span>
    </p>
  );
}

async function PersonasGrid({ personas }: { personas: Promise<CommunityPersona[]> }) {
  const list = await personas;
  if (list.length === 0) {
    return (
      <p className="bs-news-empty">
        Nothing in the persona catalog yet, or this station hasn&rsquo;t caught up with it. Be
        the first to{' '}
        <AnimatedLink href={SUBMIT_URL} className="bs-link">
          share a persona
        </AnimatedLink>
        .
      </p>
    );
  }
  return (
    <ul className="bs-stations-grid">
      {list.map((p) => (
        <CommunityPersonaCard key={p.slug} persona={p} />
      ))}
    </ul>
  );
}

export default function CommunityPersonasIndex() {
  // Started, not awaited, so the hero + CTA flush before the controller answers.
  const personas = fetchCommunityPersonas();

  return (
    <article>
      <header className="bs-news-hero">
        <p className="bs-eyebrow">THE GREEN ROOM</p>
        <h1>Community Personas.</h1>
        <p>
          A persona is a DJ identity: a name, a soul, and the handful of dials that shape
          everything they say on air. The soul is the prompt itself, not a written bio, so
          what you read on a card is what the station hands the model. Every one below came
          from another operator, and they ship with every station.
        </p>
      </header>

      <Suspense fallback={<CatalogStatSkeleton />}>
        <PersonasStat personas={personas} />
      </Suspense>

      <div className="bs-station-cta">
        <p className="bs-station-cta-copy">Dreamed up a DJ other stations should meet? Put them on the list.</p>
        <AnimatedLink href={SUBMIT_URL} variant="arrow" className="bs-station-cta-link">
          Share a persona
        </AnimatedLink>
        <AnimatedLink href="/manual/dj" className="bs-station-cta-help">
          How personas work
        </AnimatedLink>
      </div>

      <Suspense fallback={<CatalogGridSkeleton />}>
        <PersonasGrid personas={personas} />
      </Suspense>

      <p className="bs-stations-report">
        To install, open <strong>Personas → Community</strong> in your station&rsquo;s admin and
        hit <strong>Install</strong>. The persona joins your roster off-air with the
        station&rsquo;s default voice. Audition it, give it a voice and a face, then put it on
        the desk.
      </p>
    </article>
  );
}
