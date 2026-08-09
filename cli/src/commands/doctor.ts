// `subwave doctor` — pure rendering; every fact comes from runDoctor().

import { runDoctor, type Finding, type Status } from '../doctor.ts';
import { header, ok, warn, err, info, muted, pc, p, pauseForEnter } from '../ui.ts';

export async function runDoctorCommand(): Promise<void> {
  const s = p.spinner();
  s.start('Probing host, compose, controller, broadcast, state…');
  const report = await runDoctor();
  s.stop('Diagnostics complete');

  for (const sec of report.sections) {
    header(sec.name);
    for (const f of sec.findings) renderFinding(f);
  }

  // locca's doctor footer: a count, plus the most useful next step on failure.
  const { ok: okCount, warn: warnCount, fail, skip } = report.counts;
  console.log();
  const parts: string[] = [];
  parts.push(`${pc.green(`${okCount} ok`)}`);
  if (warnCount) parts.push(`${pc.yellow(`${warnCount} warn`)}`);
  if (fail) parts.push(`${pc.red(`${fail} fail`)}`);
  if (skip) parts.push(`${pc.dim(`${skip} skipped`)}`);
  console.log('  ' + parts.join('  '));

  if (fail > 0) {
    const firstFail = findFirst(report.sections, 'fail');
    if (firstFail?.hint) console.log('  ' + pc.dim('→ ' + firstFail.hint));
  } else if (warnCount > 0) {
    const firstWarn = findFirst(report.sections, 'warn');
    if (firstWarn?.hint) console.log('  ' + pc.dim('→ ' + firstWarn.hint));
  } else {
    console.log('  ' + pc.dim('→ stack looks healthy.'));
  }

  await pauseForEnter();
}

function renderFinding(f: Finding): void {
  const text = f.detail ? `${f.label} — ${pc.dim(f.detail)}` : f.label;
  if (f.status === 'ok') ok(text);
  else if (f.status === 'warn') warn(text);
  else if (f.status === 'fail') err(text);
  else info(`${f.label} — ${pc.dim(f.detail ?? 'skipped')}`);
  if (f.hint && (f.status === 'fail' || f.status === 'warn')) muted('  ↳ ' + f.hint);
}

function findFirst(sections: { findings: Finding[] }[], status: Status): Finding | null {
  for (const s of sections) {
    for (const f of s.findings) if (f.status === status) return f;
  }
  return null;
}
