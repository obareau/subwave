import { ImageResponse } from 'next/og';

// Screenshots for the PWA install dialog, referenced from app/manifest.js and
// fetched when the browser shows the "Install app" sheet. Approximates the real
// player layout so the preview matches post-install, without bundling PNGs in
// /public.

export const contentType = 'image/png';
export const dynamic = 'force-static';

const VARIANTS = {
  wide:   { width: 1280, height: 720 },
  narrow: { width: 720, height: 1280 },
};

export function generateStaticParams() {
  return Object.keys(VARIANTS).map((variant) => ({ variant }));
}

export async function GET(_req, { params }) {
  const { variant } = await params;
  const v = VARIANTS[variant];
  if (!v) return new Response('Not Found', { status: 404 });

  const { width, height } = v;
  const isWide = variant === 'wide';
  const padX = isWide ? 56 : 36;
  const padY = isWide ? 40 : 56;
  const headlineSize = isWide ? 104 : 68;
  const subtitleSize = isWide ? 28 : 20;

  return new ImageResponse(
    (
      <div
        style={{
          width,
          height,
          background: '#100e0c',
          color: '#ece6dc',
          display: 'flex',
          flexDirection: 'column',
          fontFamily: 'monospace',
          padding: `${padY}px ${padX}px`,
          boxSizing: 'border-box',
          position: 'relative',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            paddingBottom: 24,
            borderBottom: '1px solid #ece6dc',
            fontSize: 14,
            letterSpacing: '0.25em',
            textTransform: 'uppercase',
            fontWeight: 700,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 18 }}>
            <span>SUB/WAVE</span>
            <span style={{ color: '#d94b2a', fontSize: 11, letterSpacing: '0.18em' }}>
              WITH FREQUENCY
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: '#8a8278', fontSize: 11 }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: '#d94b2a',
                display: 'block',
              }}
            />
            <span>LISTENING</span>
          </div>
        </div>

        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            gap: 18,
          }}
        >
          <div style={{ color: '#8a8278', fontSize: 12, letterSpacing: '0.18em', textTransform: 'uppercase' }}>
            Now playing
          </div>
          <div
            style={{
              fontSize: headlineSize,
              lineHeight: 0.95,
              fontWeight: 800,
              letterSpacing: 0,
              color: '#ece6dc',
            }}
          >
            scanning the dial_
          </div>
          <div style={{ display: 'flex', fontSize: subtitleSize, color: '#8a8278' }}>
            <span style={{ color: '#ece6dc' }}>Live broadcast</span>
            <span style={{ marginLeft: 14 }}>· homelab radio · always on</span>
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 24,
            paddingTop: 24,
            borderTop: '1px solid #ece6dc',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              background: '#ece6dc',
              color: '#100e0c',
              padding: '14px 22px',
              fontSize: 12,
              letterSpacing: '0.3em',
              textTransform: 'uppercase',
              fontWeight: 700,
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: '#d94b2a',
                display: 'block',
              }}
            />
            TUNE IN
          </div>
          <div
            style={{
              flex: 1,
              color: '#8a8278',
              fontSize: 12,
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
            }}
          >
            single icecast stream · AI DJ between tracks
          </div>
        </div>
      </div>
    ),
    { width, height }
  );
}
