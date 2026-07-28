// Station "doctor" — the deeper, controller-side health assessment behind the
// admin Doctor panel and (later) the CLI's v2 checks. Pure data: runDoctor()
// returns a structured report; reviewReport() asks the configured LLM to turn
// that report into a prioritized, plain-English read. No rendering here.
//
// This module owns the section roster and the runners that drive it; the parts
// live in ./doctor/ and are re-exported below, so `from './doctor.js'` reaches
// the whole surface:
//
//   types.ts            findings, fix ids, the settings slice checks inspect
//   util.ts             the `safe` wrapper, error classification, formatting
//   cache.ts            the last-run cache the admin panel hydrates from
//   checks-services.ts  LLM / Navidrome / broadcast / TTS
//   checks-station.ts   capabilities, host resources, tuning coherence
//   checks-content.ts   M3Us, state-dir size, first-run setup
//   review.ts           DJ Doc's verdict pass over the assembled report
//
// The Finding/DoctorReport shape mirrors cli/src/doctor.ts (same ok|warn|fail|
// skip vocabulary) so the two surfaces stay legible together — extended with an
// optional `fix` descriptor that the panel maps to an existing admin endpoint.
// Every check reuses signals the controller already computes (LLM reachability
// probe, Subsonic ping, listener monitor, TTS routing, library stats); nothing
// here adds new probing infrastructure.

import * as settings from './settings.js';
import type { DoctorReport, DoctorSection, Finding, StationSettings } from './doctor/types.js';
import { safe } from './doctor/util.js';
import { rememberReport } from './doctor/cache.js';
import { checkBroadcast, checkLlm, checkNavidrome, checkTts } from './doctor/checks-services.js';
import { checkCapabilities, checkResources, checkTuning } from './doctor/checks-station.js';
import { checkContent, checkSetup, checkStorage } from './doctor/checks-content.js';

// Re-exported so `import * as doctor from './doctor.js'` still reaches the
// whole surface.
export * from './doctor/types.js';
export * from './doctor/cache.js';
export { clearNavidromeCache, navidromeConnectivity } from './doctor/checks-services.js';
export { reviewReport } from './doctor/review.js';
// ---------------------------------------------------------------------------
// runDoctor — assemble all sections.
// ---------------------------------------------------------------------------

// The section roster, in display order. Each check swallows its own errors and
// degrades to a 'skip'/'fail' finding (via `safe`), so one failing subsystem
// never blanks the whole report. Kept as data so both the batch runner and the
// streaming generator drive the same list.
const SECTION_CHECKS: Array<{ name: string; run: (s: StationSettings | null) => Promise<Finding[]> }> = [
  { name: 'LLM', run: (s) => checkLlm(s) },
  { name: 'Navidrome & library', run: () => checkNavidrome() },
  { name: 'Broadcast', run: () => checkBroadcast() },
  { name: 'Voice (TTS)', run: (s) => checkTts(s) },
  { name: 'Capabilities', run: (s) => checkCapabilities(s) },
  { name: 'Content', run: () => checkContent() },
  { name: 'Resources', run: () => checkResources() },
  { name: 'Tuning', run: (s) => checkTuning(s) },
  { name: 'Storage', run: () => checkStorage() },
  { name: 'Setup', run: () => checkSetup() },
];

function loadSettingsSafe(): StationSettings | null {
  try { return settings.get(); } catch { return null; }
}

// Yield each section as its check completes, so the streaming route can flush
// partial results to the panel instead of blocking on the whole assessment
// (some checks — an unreachable LLM host, the live web-search probe — take
// several seconds each).
export async function* runDoctorSections(): AsyncGenerator<DoctorSection> {
  const s = loadSettingsSafe();
  for (const c of SECTION_CHECKS) {
    yield { name: c.name, findings: await safe(() => c.run(s)) };
  }
}

export function tallyCounts(sections: DoctorSection[]): DoctorReport['counts'] {
  const counts = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const sec of sections) for (const f of sec.findings) counts[f.status]++;
  return counts;
}

// Stamp + tally a completed set of sections into a report, and cache it as the
// station's last-known health. The single place a report is minted, so every
// path (batch, stream, nightly cron) caches consistently.
export function finalizeReport(sections: DoctorSection[]): DoctorReport {
  const report: DoctorReport = { t: new Date().toISOString(), sections, counts: tallyCounts(sections) };
  rememberReport(report);
  return report;
}

export async function runDoctor(): Promise<DoctorReport> {
  const sections: DoctorSection[] = [];
  for await (const sec of runDoctorSections()) sections.push(sec);
  return finalizeReport(sections);
}


