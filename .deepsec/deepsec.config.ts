import { defineConfig } from "deepsec/config";

// NOTE: ignorePaths / priorityPaths / promptAppend do NOT belong here.
//
// `deepsec scan` reads those three only from data/<projectId>/config.json — it
// never looks at the project declaration below, and it fails SILENTLY rather
// than erroring, so a copy here looks applied while the scan happily indexes
// everything. That matters for this repo specifically: without the exclusions,
// the scan pulls in .env, controller/.env, docker/.env and state/settings.json,
// whose contents (ADMIN_PASS, the Navidrome password, LLM/TTS API keys) then
// ride into the model prompt on `process`.
//
// The real config is .deepsec/data/subwave/config.json. Edit it there.
export default defineConfig({
  projects: [
    { id: "subwave", root: ".." },
    // <deepsec:projects-insert-above>
  ],
});
