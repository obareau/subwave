// Server-side station identity lookup for the homepage's generateMetadata()
// share-card preview (issue #272).
//
// Runs in the Next.js server, NOT the browser, so it cannot use
// NEXT_PUBLIC_API_URL — that resolves to `/api`, a browser-relative path routed
// through Caddy. Reach the controller over the internal compose network via
// CONTROLLER_INTERNAL_URL, falling back to http://localhost:7701 for dev.
const CONTROLLER_BASE = (
  process.env.CONTROLLER_INTERNAL_URL || 'http://localhost:7701'
).replace(/\/$/, '');

export interface StationIdentity {
  station: string;
  stationDescription: string;
  tagline: string;
}

// Also the default of the controller's `settings.station`, so an
// un-personalised install reports this verbatim.
export const DEFAULT_STATION = 'SUB/WAVE';

// Returns null on any failure so the caller falls back to generic SUB/WAVE
// branding. The preview must never break.
export async function fetchStationIdentity(): Promise<StationIdentity | null> {
  try {
    const res = await fetch(`${CONTROLLER_BASE}/dj`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      station: typeof data?.station === 'string' ? data.station : '',
      stationDescription:
        typeof data?.stationDescription === 'string' ? data.stationDescription : '',
      tagline: typeof data?.tagline === 'string' ? data.tagline : '',
    };
  } catch {
    return null;
  }
}

export interface StationMeta {
  name: string;
  description: string;
}

// Returns null when there's nothing operator-specific to say, so callers keep
// their generic SUB/WAVE copy.
//
// Description precedence (issue #1086): settings.stationDescription, then the
// active persona's tagline (only when `allowPersonaTagline`), then a generated
// sentence naming the station.
//
// `allowPersonaTagline` is back-compat, not a good default: rung 2 IS the drift
// #1086 reports, since a link shared at noon and one at midnight describe the
// station differently. The homepage opts in only because #272 already shipped
// tagline-personalised previews there. Routes that never had it (/listen) leave
// it off and stay persona-independent.
export async function fetchStationMeta(
  { allowPersonaTagline = false }: { allowPersonaTagline?: boolean } = {},
): Promise<StationMeta | null> {
  const id = await fetchStationIdentity();
  const station = id?.station?.trim() || '';
  const stationDescription = id?.stationDescription?.trim() || '';
  const tagline = allowPersonaTagline ? id?.tagline?.trim() || '' : '';

  // No station (or still the default product name) and no usable description:
  // behave as an un-personalised install.
  const named = station && station !== DEFAULT_STATION;
  if (!named && !stationDescription && !tagline) return null;

  const name = station || DEFAULT_STATION;
  return {
    name,
    description:
      stationDescription ||
      tagline ||
      `Tune in to ${name} — one live stream, with an AI DJ picking tracks and talking between them.`,
  };
}
