// Example custom-skill data tool for SUB/WAVE — the counterpart to moon-phase.
//
// moon-phase takes no settings and touches no network. This one is the other
// shape: it has operator knobs, it calls out to a public API, and it remembers
// what it already said. Full signature:
//   (ctx, state, services, config) => data
//   ctx      — the moment (time, weather, festival, dominantMood, clock)
//   state    — cross-tick memory, persists between firings
//   services — the station facade (searchWeb, library, nowPlaying, log, …)
//   config   — this skill's own SKILL.md frontmatter, i.e. the values behind
//              the `configFields` declared below
// Return any JSON-serialisable object; `{ available: false }` tells the agent
// there is nothing worth airing right now.

export const description =
  "Get tonight's sunset time for the station's location. Returns { available, sunset, place }. Only available in the run-up to dusk, and only once a day.";

// The knobs this skill exposes in /admin/skills. Declaring them HERE — in the
// code, not against the skill's name — is what lets a COPY of this skill keep
// its form: duplicate the folder, point the copy at different coordinates, and
// you have two of them.
//
// `lat`/`lon` are deliberately NOT `integer: true`: coordinates are fractional,
// and a number field only refuses fractions when it says it wants whole ones.
export const configFields = {
  lat: { type: 'number', label: 'Latitude', min: -90, max: 90, placeholder: '51.5072' },
  lon: { type: 'number', label: 'Longitude', min: -180, max: 180, placeholder: '-0.1276' },
  place: { type: 'text', label: 'Place name', placeholder: 'London', hint: 'Optional — what the DJ should call this place on air.' },
};

// How close to sunset the line is allowed to fire, in minutes either side.
const WINDOW_MIN = 90;

export default async function sunsetCall(ctx, state, services, config) {
  const lat = Number(config?.lat);
  const lon = Number(config?.lon);
  // A knob the operator hasn't filled in yet is handled HERE, not in a `ready`
  // export — `ready(services)` doesn't get `config`, so it cannot see whether
  // this skill is configured. Say so in the log, so a silent skill is
  // explicable rather than mysterious.
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    services.log('sunset: no coordinates set — open the skill in /admin/skills and fill them in');
    return { available: false };
  }

  // Open-Meteo, keyless and already the station's weather source. `timezone=auto`
  // returns times in the zone of those coordinates — which for a station's own
  // location is the zone the clock below is in.
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=sunset&timezone=auto`;

  let sunsetAt;
  try {
    // Always bound your own network call. The station guards the whole tool at
    // 8s, but a hung socket inside it burns the segment's budget either way.
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    sunsetAt = json?.daily?.sunset?.[0]; // "2026-08-04T20:47"
  } catch (err) {
    // A throw degrades cleanly to "no data" anyway; catching it just makes the
    // reason visible in the booth log.
    services.log(`sunset: lookup failed — ${err.message}`);
    return { available: false };
  }
  if (typeof sunsetAt !== 'string' || !sunsetAt.includes('T')) return { available: false };

  const [date, hhmm] = sunsetAt.split('T');

  // Said it already today? `state` is this skill's own memory between firings —
  // the DJ's brief asks for one mention, and this is what makes that true even
  // though the skill is offered every time its cooldown lapses.
  if (state.saidOn === date) return { available: false };

  // Only worth airing near dusk. ctx.clock.hhmm is the station's wall clock.
  const minutes = s => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const now = ctx?.clock?.hhmm;
  if (!now || Math.abs(minutes(now) - minutes(hhmm)) > WINDOW_MIN) return { available: false };

  // Mark it only once we're actually returning the line.
  state.saidOn = date;

  return {
    available: true,
    sunset: hhmm,                          // "20:47" — let the DJ phrase it
    place: config?.place || null,          // null → the DJ just won't name it
  };
}
