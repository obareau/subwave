// Asset shapes from the controller's /sfx and /beds routes. The generic
// settings-save primitives (SettingsData, SaveSettings, SectionHeader,
// PreviewButton) live in settings/shared.tsx, not here.

export interface SfxEntry {
  name: string;
  description?: string;
  size?: number;
  durationSec?: number;
  builtin?: boolean;
  source?: string;
}

export interface SfxData {
  sfx?: SfxEntry[];
  generatorReady?: boolean;
}

export interface SfxForm {
  name: string;
  description: string;
  prompt: string;
  durationSec: string;
}

export interface BedEntry {
  name: string;
  description?: string;
  size?: number;
  durationSec?: number | null;
  source?: string;
  builtin?: boolean;
}

export interface BedsData {
  beds?: BedEntry[];
  minDurationSec?: number;
  maxGenDurationSec?: number;
  generatorReady?: boolean;
}

export interface BedsForm {
  name: string;
  description: string;
  prompt: string;
  durationSec: string;
}

export type JingleImportFailure = { name: string; reason: string };
export type JingleImportResult = {
  ok: number;
  total: number;
  failures: JingleImportFailure[];
  aborted: boolean;
};

export interface VoiceEntry {
  file: string;
  size?: number;
  durationSec?: number | null;
  legacy?: boolean;
  warning?: 'short' | 'long' | null;
}

export interface VoiceData {
  voices?: VoiceEntry[];
  dir?: string;
  legacyDir?: string;
  ffmpeg?: boolean;
  advisory?: { minSec: number; maxSec: number };
}
