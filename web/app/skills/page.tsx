import { Suspense } from 'react';
import { AnimatedLink } from '@/components/ui/animated-link';
import CommunitySkillCard from '@/components/skills/CommunitySkillCard';
import { CatalogGridSkeleton, CatalogStatSkeleton } from '@/components/ui/catalog-skeleton';
import { fetchCommunitySkills, type CommunitySkill } from '@/lib/communitySkills';
import { skillSubmitUrl } from '@/lib/repo';
import { pageMeta } from '@/lib/seo';

export const metadata = pageMeta({
  title: 'SUB/WAVE — Community Skills',
  description:
    'The community skill catalog: prompt-only DJ segments other operators wrote and sent in. Read the briefs here, install them from your own admin console.',
  path: '/skills',
});

// The catalog is baked into the controller image and refreshed on update, so
// read it live from the local controller at request time rather than at build.
export const dynamic = 'force-dynamic';

const REPO = 'https://github.com/perminder-klair/subwave';
// Submission opens a GitHub Issue Form in the community catalog repo; a workflow
// turns it into a one-file PR and the catalog rebuilds on merge.
const SUBMIT_URL = skillSubmitUrl();
const DOCS_URL = `${REPO}/blob/main/docs/custom-skills.md`;

// Each region reads the one in-flight promise rather than calling the loader
// itself — see the note in app/shows/page.tsx.

async function SkillsStat({ skills }: { skills: Promise<CommunitySkill[]> }) {
  const count = (await skills).length;
  if (count === 0) return null;
  return (
    <p className="bs-stat-strip">
      <span>
        <strong>{count}</strong> {count === 1 ? 'skill' : 'skills'} in the catalog
      </span>
    </p>
  );
}

async function SkillsGrid({ skills }: { skills: Promise<CommunitySkill[]> }) {
  const list = await skills;
  if (list.length === 0) {
    return (
      <p className="bs-news-empty">
        Nothing in the skill catalog yet, or this station hasn&rsquo;t caught up with it. Be the
        first to{' '}
        <AnimatedLink href={SUBMIT_URL} className="bs-link">
          share a skill
        </AnimatedLink>
        .
      </p>
    );
  }
  return (
    <ul className="bs-stations-grid">
      {list.map((s) => (
        <CommunitySkillCard key={s.slug} skill={s} />
      ))}
    </ul>
  );
}

export default function CommunitySkillsIndex() {
  // Started, not awaited, so the hero + CTA flush before the controller answers.
  const skills = fetchCommunitySkills();

  return (
    <article>
      <header className="bs-news-hero">
        <p className="bs-eyebrow">THE EXCHANGE</p>
        <h1>Community Skills.</h1>
        <p>
          A skill is a segment the DJ can air between tracks. You write a short brief saying
          what to cover and when to stay quiet; the DJ writes the actual words at air time,
          around whatever is playing. Every one below came from another operator, and they
          ship with every station.
        </p>
      </header>

      <Suspense fallback={<CatalogStatSkeleton />}>
        <SkillsStat skills={skills} />
      </Suspense>

      <div className="bs-station-cta">
        <p className="bs-station-cta-copy">Taught your DJ something good? Send the brief in.</p>
        <AnimatedLink href={SUBMIT_URL} variant="arrow" className="bs-station-cta-link">
          Share a skill
        </AnimatedLink>
        <AnimatedLink href={DOCS_URL} className="bs-station-cta-help">
          How it works
        </AnimatedLink>
      </div>

      <Suspense fallback={<CatalogGridSkeleton />}>
        <SkillsGrid skills={skills} />
      </Suspense>

      <p className="bs-stations-report">
        To install, open <strong>Skills → Community</strong> in your station&rsquo;s admin and
        hit <strong>Install</strong>. Every skill arrives switched off, so you can read the
        brief before the DJ ever airs it.
      </p>
    </article>
  );
}
