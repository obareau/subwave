---
name: subwave-discord-release
description: Draft a Discord release announcement for SUB/WAVE from a release PR, tag, or version number. Use this skill whenever the user wants to "write a Discord announcement / post", "announce the release on Discord", "draft a release announcement", "tell the Discord about vX.Y.Z", "post the release to the community", or hands you a release-please PR / release tag and asks for community copy. The skill knows the house voice (radio-themed, warm, no em-dashes), how to pull the changelog from GitHub, how to translate conventional-commit lines into listener-facing benefits, and to size the post to the release. It outputs a ready-to-paste markdown block; it does NOT post to Discord.
---

# SUB/WAVE Discord release announcement

Write one Discord post announcing a SUB/WAVE release. The audience is listeners and operators in the community server, not developers reading a changelog. The job is to turn the release's commits into a short, warm, on-brand post they'll actually read.

## Why this skill exists

The raw material is a release-please PR body or a published GitHub release: a list of `feat(...)` / `fix(...)` lines with issue numbers. That's changelog-speak. The community post needs the *listener-facing* version: what each change lets them do, in plain words, with the station's radio-booth personality. The easy things to get wrong are the voice (reads like AI release notes), em-dashes (a hard no), overselling a small maintenance release, burying the good stuff under internal chores, and reusing last release's opener or closer (every post gets freshly coined ones). This skill encodes the house format and the translation step.

## Step 1: Pull the release data

Get the grouped changelog. Depending on what the user gives you:

```bash
# a release-please PR (the "chore(main): release X.Y.Z" PR)
gh pr view <PR#> --repo perminder-klair/subwave --json title,body,baseRefName

# a published release tag
gh release view v<X.Y.Z> --repo perminder-klair/subwave

# or list recent releases if they only gave a vague "the latest one"
gh release list --repo perminder-klair/subwave --limit 5
```

The release-please body groups commits under **Features** and **Bug Fixes** with issue links. That grouping is your starting skeleton. Note the version and the release URL (`https://github.com/perminder-klair/subwave/releases/tag/v<X.Y.Z>`) for the sign-off link.

## Step 2: Triage the commits

Not every line earns a spot. Read each commit through the ear of a listener/operator:

- **Headline features** get a bulleted callout with a thematic emoji and a bold lead. These are the user-visible wins: new personas, new stations, new transitions, new controls, new skills.
- **Fixes** get a compact `🔧` list further down, framed by why they matter ("no more X leaking to air"), not by the code path.
- **Drop or fold** pure internals: release chores, CI, refactors, dependency bumps, anything a listener would never perceive. Don't pad the post to look bigger than the release.

Translate every kept line out of commit-speak. `fix(llm): stop runaway </think> repetition loops leaking to air` becomes "No more runaway think-loops leaking to air. Reasoning models used to occasionally spill their inner monologue over the stream. That's plugged." The commit tells you *what code changed*; you write *what the listener will notice*.

## Step 3: Size the post to the release

A big feature release and a small maintenance drop should not read the same. Say which one it is in the intro, honestly. A five-feature release earns the full treatment; a two-feature-plus-fixes release should say "smaller drop this time, but a good one" and stay short. Overselling a patch release is the fastest way to make the wire feel like marketing.

## The format

Output a single fenced ```markdown code block so the user can copy the raw text straight into Discord. The shape:

```
📻 SUB/WAVE vX.Y.Z [freshly coined on-air phrase — see "Openers and closers"] 📻

[Intro: one short paragraph. Name the release's character (big / smaller), say what it's mostly about in plain words, and lead into the list. Radio metaphors welcome (on the dial, in the booth, on air).]

[EMOJI] **Feature lead in bold.** One to three sentences on what it is and what it lets them do. Pick an emoji that fits the feature, not a generic sparkle.

[EMOJI] **Next feature.** ...

[Transition line into the smaller stuff, ending in 👇. e.g. "And a handful of fixes that matter more than they sound 👇"]

🔧 Plain-language fix, framed by why it matters.
🔧 Next fix.

Full notes: https://github.com/perminder-klair/subwave/releases/tag/vX.Y.Z

[Thank-you closer to the people who filed issues and sent PRs, then a fresh sign-off. See "Openers and closers" below.]

@everyone
```

Notes on the parts:

- **Headline**: the `📻 … 📻` bookend around `SUB/WAVE vX.Y.Z` is the fixed part; the phrase after the version is coined fresh every release (see "Openers and closers").
- **Feature bullets**: emoji + **bold lead**, then prose. One idea per bullet. Merge related commits (e.g. two new stations) into one bullet rather than listing each.
- **Fixes**: `🔧` prefix, one line each, benefit-first. Only include fixes a user would feel; fold the rest into a single "plus the usual under-the-hood tidying" line or drop them.
- **`@everyone` goes at the very bottom**, after the sign-off. (This is the operator's standing preference. Confirm only if they say otherwise.)

## Openers and closers: coin fresh ones every release

Two lines go stale fastest on the wire: the headline phrase inside the `📻 … 📻` bookend, and the closer (thank-you sentence + sign-off). **Both are written new for every release.** Nothing in this section is a menu to pick from; it's a description of the register.

How to coin them:

1. Write two or three candidates for each before settling. Pull imagery from the whole radio world, not just the dial: the transmitter, the tower, the fader, the needle, the mixing desk, the late-night booth, the request line, the test card, static between stations, the ON AIR lamp, a signal finding its frequency. A line that riffs on *this release's content* (a landing-page release can open with the shop window, a transitions release with the crossfade) beats a generic radio line.
2. Keep the one that matches the release's energy: a big feature drop can be loud, a patch release can be a quiet, dry line.
3. Check it against the retired list below. If it matches or is a near-synonym of anything there (same verb, same image), throw it out and coin another. Swapping "airwaves" for "wire" is not a new line.

The thank-you sentence follows the same rule: tie it to what actually happened this release (who reported the bug that got fixed, whose idea shipped), not a stock "thanks for the feedback" shape.

**Retired lines** (already aired; never reuse, including near-synonyms):

- Headlines: "is on the airwaves"
- Sign-offs: "See you on the dial", "Catch you on air", "go make some noise"
- Thank-yous: "Every fix in that list started as one of your reports. Keep them coming."

**Maintenance:** when the user confirms a post has shipped, append its headline phrase, sign-off, and thank-you line to the retired list above so future runs can't repeat them.

## Writing rules

- **No em-dashes.** Reword with a comma, a colon, parentheses, or a full stop. Hard rule for the wire.
- Warm, plain, a little playful. First person plural ("this one's built on your feedback") reads human and fits a community voice.
- No changelog-speak, no inflated significance, no rule-of-three padding.
- Straight quotes. Emoji are welcome here (unlike the news dispatch) because it's Discord, but each should carry meaning, not decorate.
- Keep it scannable: short intro, bulleted features, compact fixes, link, sign-off. Discord readers skim.

## Required: de-slop before delivering

Run the finished draft through the **`no-ai-slop`** skill in edit mode and apply its edits before you hand it over. This is where lingering AI tells, any stray em-dash, and rule-of-three habits get caught. It's the same discipline the news dispatch uses, and it's what keeps the post from reading like generated release notes.

Hold the house voice against it: the no-em-dash rule above is absolute here, and the warm first-person plural and the emoji that carry meaning are voice signals to preserve, not slop to strip.

## Delivering

Hand back the final post inside one ```markdown fenced block (so `@everyone`, bold, and links survive the copy). Then offer a quick follow-up: alternate sign-offs, a shorter cut, or dropping the fixes section. The operator usually iterates on the closer and the length.

## Reference: the house voice

The previous release announcements are the tonal reference. If the user pastes an older post as "here's our old one," match its rhythm and warmth, not its exact wording or emoji. The v0.37.0 post (big feature release: guest co-hosts, programmes, chop transition, community personas) and the v0.39.0 post (smaller: persona fader controls, new personas/stations, LLM fixes) bracket the range from full-treatment to compact-drop.
