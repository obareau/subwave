// Which voice the STATION DEFAULT engine speaks with when no persona overrides
// it — the ladder the controller's audio/tts.ts walks, mirrored for the admin
// "Play sample" / "Test corrections" buttons. Lives here, beside
// VoicePreviewButton, because more than one panel needs it and a hand-copied
// ladder is one that drifts. No React, no DOM — safe to unit-import.

export interface DefaultVoiceSource {
  kokoro?: { voice?: string };
  chatterbox?: { referenceVoice?: string };
  pocketTts?: { voice?: string };
  cloud?: { voice?: string };
}

// Piper resolves its voice inside the engine and `remote` carries none, so both
// answer '' — same as an engine we don't recognize.
export function defaultEngineVoice(engine: string, tts: DefaultVoiceSource): string {
  if (engine === 'kokoro') return tts.kokoro?.voice || '';
  if (engine === 'chatterbox') return tts.chatterbox?.referenceVoice || '';
  if (engine === 'pocket-tts') return tts.pocketTts?.voice || '';
  if (engine === 'cloud') return tts.cloud?.voice || '';
  return '';
}
