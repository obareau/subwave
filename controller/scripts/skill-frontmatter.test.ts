// Pins for SKILL.md frontmatter parsing (src/skills/loader.ts) after the swap
// from the hand-rolled line splitter to real YAML.
//
// Two contracts are load-bearing and pull in opposite directions:
//   • `data` stays Record<string, string> — the tool's 4th `config` arg,
//     config-fields coercion, preservedFrontmatter and parseTags are all built
//     on strings, so YAML's typed values are flattened back down.
//   • a block YAML refuses falls back to the legacy parser — the sharp case is
//     an unquoted colon, which the old parser accepted and which is therefore
//     on operators' disks today.
//
// Run: `npm test -- skill-frontmatter`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter } from '../src/skills/loader.js';

const md = (front: string, body = 'The brief.') => `---\n${front}\n---\n${body}\n`;

test('the shape every shipped skill uses is unchanged', () => {
  const { data, body, malformed } = parseFrontmatter(
    md('name: news\nlabel: News headlines\ncooldown: 45m\nfeed: https://feeds.bbci.co.uk/news/rss.xml'),
  );
  assert.equal(malformed, undefined);
  assert.deepEqual(data, {
    name: 'news',
    label: 'News headlines',
    cooldown: '45m',
    feed: 'https://feeds.bbci.co.uk/news/rss.xml',
  });
  assert.equal(body, 'The brief.');
});

test('no frontmatter block — the whole file is the brief', () => {
  const { data, body } = parseFrontmatter('Just a brief, no fences.\n');
  assert.deepEqual(data, {});
  assert.equal(body, 'Just a brief, no fences.');
});

test('a YAML list flattens to the comma form the consumers already parse', () => {
  const { data } = parseFrontmatter(md('name: x\ntags:\n  - late-night\n  - factual'));
  assert.equal(data.tags, 'late-night, factual');
});

test('an inline flow list works too, and matches the bare comma form', () => {
  const flow = parseFrontmatter(md('name: x\ncontext: [weather, time]')).data;
  const bare = parseFrontmatter(md('name: x\ncontext: weather, time')).data;
  assert.equal(flow.context, 'weather, time');
  assert.deepEqual(flow, bare);
});

test('typed scalars flatten to strings — nothing downstream speaks numbers', () => {
  const { data } = parseFrontmatter(md('name: x\nfeedMaxItems: 6\nwindow: true'));
  assert.equal(data.feedMaxItems, '6');
  assert.equal(typeof data.feedMaxItems, 'string');
  assert.equal(data.window, 'true');
});

test('a key with no value is an empty string, as the line parser gave', () => {
  const { data } = parseFrontmatter(md('name: x\nlabel:'));
  assert.equal(data.label, '');
});

test('quotes are consumed, not kept', () => {
  const { data } = parseFrontmatter(md(`name: x\nlabel: "Quoted: label"\nother: 'single'`));
  assert.equal(data.label, 'Quoted: label');
  assert.equal(data.other, 'single');
});

test('a comment line is dropped and an inline comment does not enter the value', () => {
  const { data } = parseFrontmatter(md('# a note\nname: x\ncooldown: 45m # tuned down'));
  assert.deepEqual(data, { name: 'x', cooldown: '45m' });
});

test('a # inside a URL is not a comment', () => {
  const { data } = parseFrontmatter(md('name: x\nfeed: https://example.com/a.xml#top'));
  assert.equal(data.feed, 'https://example.com/a.xml#top');
});

test('a block scalar becomes one value instead of the literal "|-"', () => {
  const { data } = parseFrontmatter(md('name: x\ntoolDescription: >-\n  One long line\n  wrapped in the file.'));
  assert.equal(data.toolDescription, 'One long line wrapped in the file.');
});

test('a nested map is dropped — no consumer speaks one', () => {
  const { data } = parseFrontmatter(md('name: x\nnested:\n  a: 1\n  b: 2\nlabel: kept'));
  assert.deepEqual(data, { name: 'x', label: 'kept' });
});

test('an unquoted colon falls back to the legacy parser rather than losing the skill', () => {
  const { data, body, malformed } = parseFrontmatter(md('name: x\nlabel: News: Today'));
  assert.ok(malformed, 'the YAML error is reported so loadSkillDir can warn');
  assert.equal(data.name, 'x');
  assert.equal(data.label, 'News: Today', 'the value the old parser produced');
  assert.equal(body, 'The brief.', 'the brief survives a malformed block');
});

test('a duplicate key falls back, and the fallback is last-wins as before', () => {
  const { data, malformed } = parseFrontmatter(md('name: x\nlabel: first\nlabel: second'));
  assert.ok(malformed);
  assert.equal(data.label, 'second');
});

test('a non-map frontmatter block degrades instead of returning junk', () => {
  const { data, body } = parseFrontmatter(md('- just\n- a list'));
  assert.deepEqual(data, {});
  assert.equal(body, 'The brief.');
});

test('a leading BOM does not defeat the fence match', () => {
  const { data } = parseFrontmatter('﻿' + md('name: x'));
  assert.equal(data.name, 'x');
});
