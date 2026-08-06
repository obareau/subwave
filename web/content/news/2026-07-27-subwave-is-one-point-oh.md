---
title: SUB/WAVE is 1.0
date: 2026-07-27
category: Release
version: v1.0.0
author: The SUB/WAVE desk
excerpt: Three months and forty-eight releases after the first commit, the version counter rolls over to 1.0.0. Here is what the number promises, what shipped with it, and how to update.
---

The version counter finally rolled over. Three months and forty-eight releases after the first commit, SUB/WAVE is 1.0.0. The first milestone is done, and this dispatch is a thank-you note as much as a release note.

## What's new

The release itself is a normal drop wearing a big number. The player has a new face, Unit SW-9, which replaces the old [Spool skin](/news/give-your-player-a-new-face) (find it in the palette menu).

![The Unit SW-9 skin: a milled-aluminium panel of soft-touch keys and weighted knobs on the left, a dot-matrix grille showing the cover art, and a black window on the right reading the track title, artist, elapsed time and a level display](/screenshots/listen-unit.webp) The all-in-one image now runs acoustic analysis on your GPU, which got [its own dispatch yesterday](/news/one-click-on-the-gpu). And stem blends no longer demand a full re-analysis of your library. Turn the stem cache on and it backfills on its own, pass by pass, with a disk budget you can set under Settings → Transitions.

The bigger news is the number itself. From 1.0 on, the surfaces you build a station on are stable. Your `.env`, your `state/settings.json`, the layout of the `state/` folder and the compose files are covered by semver now. If a future release ever has to break one of them, it will be a major version with a migration path, not a surprise inside a minor bump.

## How to update

Standalone installs:

```
subwave update
```

Clone installs can run the same command (it does the git pull and rebuilds what changed), or stay with plain compose:

```
docker compose pull && docker compose up -d
```

## Why it matters

A radio station is the kind of thing you set up once and expect to keep humming. The 1.0 promise is that updates respect that. Your settings, your library database and your station folders carry forward, release after release.

And the milestone belongs to everyone who filed an issue, requested a song, or left the stream playing overnight. Thank you. The next one is already taking shape, with pause-then-talk breaks, on-pick track analysis and pluggable music sources on the bench. The booth light stays on.
