'use client';

import dynamic from 'next/dynamic';

// Client boundary so the constellation (requestAnimationFrame, window, pointer
// gestures) can be loaded with ssr:false from the otherwise-server DJ section.
// The weight sits behind this lazy boundary, keeping the landing page light.
const ObservatoryShowcase = dynamic(() => import('./ObservatoryShowcase'), {
  ssr: false,
  loading: () => (
    <div className="obs-embed-box grid place-items-center">
      <span className="bs-eyebrow text-muted">mapping the library…</span>
    </div>
  ),
});

export default function ObservatoryEmbed() {
  return <ObservatoryShowcase />;
}
