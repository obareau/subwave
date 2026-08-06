// Merges voices discovered from a cloud TTS provider with the curated fallback
// list into VoicePicker groups. Shared by the Personas and Settings pages so
// the two can't drift.
//
// Per provider: openai-compatible has no curated list (ids are server-specific)
// so the picker is entirely discovered; elevenlabs / fish-audio list discovered
// voices first under "Your voices", which is where an operator's CLONED voices
// appear and a hardcoded list can never know about; openai is never
// discoverable, so its curated list is complete by construction.
import { CLOUD_VOICES } from './cloudVoices';
import type { VoicePickerGroup } from '../components/admin/tts/VoicePicker';
import type { DiscoveredVoice } from '../hooks/useVoiceDiscovery';

// Sentinel for the "type your own id" action row; the call site maps it to ''.
export const CUSTOM_VOICE_ID = '__custom__';

const CUSTOM_ROW = { id: CUSTOM_VOICE_ID, label: 'Custom voice id…', previewVoice: null };

// Providers with a voice-list endpoint. Mirrors listVoices() in
// controller/src/llm/internal/speech/voice-catalog.ts.
export function providerSupportsDiscovery(provider: string): boolean {
  return provider === 'openai-compatible' || provider === 'elevenlabs' || provider === 'fish-audio';
}

function curatedFor(provider: string) {
  return CLOUD_VOICES[provider as keyof typeof CLOUD_VOICES] || [];
}

/** Every voice id the picker can offer, so callers can tell a known voice from
 *  a custom one without clobbering a valid selection on a provider change. */
export function knownCloudVoiceIds(provider: string, discovered: DiscoveredVoice[]): Set<string> {
  const ids = new Set<string>();
  for (const v of curatedFor(provider)) ids.add(v.id);
  for (const v of discovered) ids.add(v.id);
  return ids;
}

export function isKnownCloudVoice(provider: string, discovered: DiscoveredVoice[], voice: string): boolean {
  const v = voice.trim();
  return !!v && knownCloudVoiceIds(provider, discovered).has(v);
}

/** Always ends with the "Custom voice id…" action row so an operator can enter
 *  an id the server never advertised. */
export function buildCloudVoiceGroups(provider: string, discovered: DiscoveredVoice[]): VoicePickerGroup[] {
  const curated = curatedFor(provider);
  const groups: VoicePickerGroup[] = [];

  if (discovered.length) {
    const discoveredIds = new Set(discovered.map(v => v.id));
    // Discovered wins on an id collision: it carries the operator's own name
    // for the voice, which beats the stock label.
    const rest = curated.filter(v => !discoveredIds.has(v.id));
    groups.push({
      label: provider === 'elevenlabs' || provider === 'fish-audio' ? 'Your voices' : 'Discovered',
      voices: discovered.map(v => ({ id: v.id, label: v.label, hint: v.hint })),
    });
    if (rest.length) groups.push({ label: 'Presets', voices: rest.map(v => ({ id: v.id, label: v.label })) });
  } else if (curated.length) {
    groups.push({ voices: curated.map(v => ({ id: v.id, label: v.label })) });
  }

  groups.push({ voices: [CUSTOM_ROW] });
  return groups;
}
