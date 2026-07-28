// The tagger's one logging chokepoint: emit the terse `[tag] …` console line
// AND the structured event sentinel the controller relays to the admin panel.
// One call per notable milestone, so the console output and the panel's
// progress feed can never drift apart.
//
// Part of the tag-library/ split - see ../tag-library.ts for main().

import { makeEventLogger } from '../tagger-progress.js';

export const logEvent = makeEventLogger('tag');
