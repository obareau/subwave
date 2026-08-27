// Issue #1411: onboarding persisted the station timezone and weather location
// through settings.update(), but only the timezone reached the running process.
// The settings page then showed Buenos Aires while context.ts kept querying the
// boot-time Chandigarh coordinates until a restart.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const stateRoot = mkdtempSync(join(tmpdir(), 'subwave-weather-live-'));
process.env.STATE_DIR = stateRoot;

const settings = await import('../src/settings.js');
const { getWeather, invalidateWeatherCache } = await import('../src/context.js');

test('a settings.update weather change reaches the next context fetch without a restart', async () => {
  await settings.load();
  invalidateWeatherCache();

  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return new Response(JSON.stringify({
      current: { temperature_2m: 25, weather_code: 0, is_day: 1 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const before = await getWeather();
    assert.equal(before.location, 'Punjab');

    await settings.update({
      weather: {
        lat: -34.6037,
        lng: -58.3816,
        locationName: 'Buenos Aires, Buenos Aires F.D., Argentina',
        units: 'metric',
      },
    });

    const after = await getWeather();
    assert.equal(after.location, 'Buenos Aires, Buenos Aires F.D., Argentina');
    assert.equal(urls.length, 2, 'the changed coordinates bypass the old 30-minute cache entry');
    assert.match(urls[1], /latitude=-34\.6037&longitude=-58\.3816/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test.after(() => {
  rmSync(stateRoot, { recursive: true, force: true });
});
