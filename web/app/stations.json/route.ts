// Runtime JSON view of the community stations directory, for the native app.
//
// It lives at /stations.json, NOT under /api: the Caddyfile routes /api/* to the
// controller, so an /api/stations route would never reach this Next.js app.
import { NextResponse } from 'next/server';
import { getAllStations } from '@/lib/stations';

// Sourced from the community catalog (ISR-revalidated in stations.ts), so this
// re-generates on that cadence rather than only at deploy time; force-static
// keeps it a cached static asset between revalidations.
export const dynamic = 'force-static';

export async function GET() {
  return NextResponse.json(await getAllStations(), {
    headers: {
      'Cache-Control': 'public, max-age=300',
      // RN fetch ignores CORS, but this lets a browser client reuse the feed too.
      'Access-Control-Allow-Origin': '*',
    },
  });
}
