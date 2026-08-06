import { ImageResponse } from 'next/og';

// The social share card, served at /og. 1200x630 is the canonical Open Graph
// size honoured by X, Slack, iMessage, Discord, LinkedIn, Facebook.
//
// A plain route handler, NOT the `opengraph-image` file convention: that
// auto-injects an <meta og:image> whose URL Next rebuilds from `metadataBase`,
// and Next drops metadataBase on the force-dynamic homepage, pinning it to a
// localhost origin. From a normal route, app/layout.js can emit an absolute
// <meta og:image> itself and it survives untouched.

export const contentType = 'image/png';
export const dynamic = 'force-static';

const BG = '#100e0c';
const INK = '#ece6dc';
const MUTED = '#8a8278';
const ACCENT = '#d94b2a';

export function GET() {
  return new ImageResponse(
    (
      <div
        style={{
          width: 1200,
          height: 630,
          background: BG,
          color: INK,
          display: 'flex',
          flexDirection: 'column',
          fontFamily: 'monospace',
          padding: '56px 64px',
          boxSizing: 'border-box',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            paddingBottom: 22,
            borderBottom: `2px solid ${INK}`,
            fontSize: 16,
            letterSpacing: '0.28em',
            textTransform: 'uppercase',
            fontWeight: 700,
          }}
        >
          <span>SUB/WAVE</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, color: ACCENT, fontSize: 14 }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: ACCENT, display: 'block' }} />
            <span>ON AIR</span>
          </div>
        </div>

        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            gap: 26,
          }}
        >
          <div
            style={{
              color: MUTED,
              fontSize: 20,
              letterSpacing: '0.24em',
              textTransform: 'uppercase',
              fontWeight: 700,
            }}
          >
            A real internet radio station
          </div>
          <div
            style={{
              fontSize: 92,
              lineHeight: 0.98,
              fontWeight: 800,
              letterSpacing: '-0.02em',
              color: INK,
            }}
          >
            The radio station with a DJ who never sleeps.
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            paddingTop: 22,
            borderTop: `1px solid ${INK}`,
            color: MUTED,
            fontSize: 18,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
          }}
        >
          <span style={{ color: INK }}>One stream</span>
          <span>·</span>
          <span>AI DJ between tracks</span>
          <span>·</span>
          <span style={{ color: ACCENT }}>Open source</span>
        </div>
      </div>
    ),
    { width: 1200, height: 630 },
  );
}
