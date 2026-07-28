// The description line shared by the three community showcase cards
// (/personas, /skills, /shows). Catalog copy runs from ~170 characters to a
// full 1000-character persona soul, which left the grid badly ragged — one card
// four lines tall next to one running twenty.
//
// Long briefs are clamped to four lines behind a native <details> disclosure, so
// nothing is lost (these pages are the only place a visitor can read the copy —
// there is no per-entry detail route) and the showcase pages stay server
// components with no client JS. Short briefs render as a plain paragraph rather
// than wearing a toggle that would reveal nothing.
//
// The threshold is deliberately below four lines' worth of text at the widest
// column: an occasional no-op toggle is a smaller sin than text clamped away
// with no way to open it.
const CLAMP_CHARS = 240;

export default function CatalogBrief({ text }: { text?: string }) {
  const body = (text || '').trim();
  if (!body) return null;

  if (body.length <= CLAMP_CHARS) return <p className="bs-skill-brief">{body}</p>;

  return (
    <details className="bs-skill-brief-block">
      {/* Phrasing content only — <summary> can't legally hold a <p>. */}
      <summary className="bs-skill-brief-summary">
        <span className="bs-skill-brief">{body}</span>
        <span className="bs-skill-brief-toggle">
          <span className="bs-skill-brief-open">Read more</span>
          <span className="bs-skill-brief-close">Show less</span>
        </span>
      </summary>
    </details>
  );
}
