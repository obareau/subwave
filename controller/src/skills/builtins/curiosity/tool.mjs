// Curiosity — one "on this day" event for today, de-duped against curiosities
// already aired (durable, survives restart, via services.recall). Returns
// available:false when nothing fresh — the brief then falls back to a light
// date/season observation rather than staying silent.
// This skill writes its own factoid when the feed has nothing — so a forced run
// must NOT stand down on `available: false` the way a data-bound skill does
// (issue #1412). skills/abstain-policy.ts knows this by kind as well, so an
// upgraded station that still has the old copy of this file behaves the same;
// the declaration is here so a COPY of this skill keeps the behaviour too.
export const requiresData = false;

export const description = 'Fetch one historical "on this day" event for today\'s date — filtered for cultural / scientific / sporting entries since 1850, and de-duped against curiosities already aired. Returns `available: false` when no fresh item exists; treat that as a cue to fall back to your own oddly-specific factoid under the capability brief, not as a reason to stay silent.';

export default async function getCuriosityItem(ctx, state, services) {
  const items = await services.onThisDay();
  const fresh = items.filter(it => !services.recall.seen(it.text));
  if (!fresh.length) return { available: false };
  // Burn-on-read into the durable ledger so a later tick — or one after a
  // restart — doesn't re-offer the same event (issue #577).
  for (const it of fresh.slice(0, 3)) services.recall.remember(it.text);
  return {
    available: true,
    items: fresh.slice(0, 3).map(it => ({ year: it.year, text: it.text })),
  };
}
