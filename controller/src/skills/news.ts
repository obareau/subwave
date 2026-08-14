// News feed helpers — fetch a feed and hash headlines for dedup. These back the
// `getHeadlines` segment tool (llm/segment-tools.js); there is no standalone
// "news skill" object — the segment-director agent (skills/_agent.js) decides
// when a headline airs. The feed URL/max-items come from the news capability
// (overridable via state/skills/news/SKILL.md `feed:`), falling back to
// config.news (env NEWS_FEED_URL / NEWS_MAX_ITEMS, default BBC).
//
// Parsing goes through fast-xml-parser rather than the regex scanner this
// module shipped with. The feed URL is OPERATOR input — any URL typed into the
// news skill's `feed:` field — and the old scanner only matched shallow RSS 2.0
// `<item>` blocks: an Atom feed (`<entry>`/`<summary>`), an RDF/RSS-1.0 feed
// (`<item>` at the document root, no `<channel>`), a namespaced title
// (`<dc:title>`), or a nested CDATA section all returned ZERO items. That
// failure is silent — the segment director just finds no headlines and the news
// beat quietly never airs — which is why it's worth a dependency.
//
// `parseFeed` is the pure seam (no network, no config), pinned by
// scripts/news-feed.test.ts.

import { XMLParser } from 'fast-xml-parser';
import { config } from '../config.js';
import { fetchWithTimeout } from '../util/fetch-timeout.js';

export interface Headline {
  title: string;
  description: string;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  trimValues: true,
  ignoreDeclaration: true,
  // Namespace prefixes are noise here and actively harmful: an RDF feed's root
  // is `rdf:RDF`, and plenty of feeds carry `dc:title` / `content:encoded`.
  // Stripping them collapses every dialect onto the same plain tag names.
  removeNSPrefix: true,
  // Keep every value a STRING. With the default numeric coercion a headline of
  // "2026" arrives as the number 2026 and a version-like title ("1.2.3") can
  // lose a component — text is text.
  parseTagValue: false,
  parseAttributeValue: false,
});

// A parsed node is a string, or an object carrying its text under `#text` when
// the element had attributes (`<title type="html">…</title>`), or an array when
// the tag repeated. Flatten all three to a plain string.
function textOf(node: unknown): string {
  if (node == null) return '';
  if (Array.isArray(node)) return textOf(node[0]);
  if (typeof node === 'object') return textOf((node as Record<string, unknown>)['#text']);
  return String(node);
}

function stripHtml(s: string): string {
  return (s || '')
    // Entities are decoded by the parser; these handle a doubly-encoded feed,
    // where the decoded text still contains &amp;-style escapes.
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function asRecord(node: unknown): Record<string, unknown> | null {
  return node && typeof node === 'object' && !Array.isArray(node) ? (node as Record<string, unknown>) : null;
}

// Locate the entry list across the three dialects in the wild:
//   RSS 2.0    <rss><channel><item>…
//   RSS 1.0    <RDF><item>…            (items are siblings of <channel>, not children)
//   Atom       <feed><entry>…
// Returns [] when the document is not a feed at all.
function entriesOf(doc: Record<string, unknown>): Record<string, unknown>[] {
  const roots: Record<string, unknown>[] = [];
  for (const value of Object.values(doc)) {
    const root = asRecord(value);
    if (!root) continue;
    roots.push(root);
    // RSS 2.0 nests the items one level deeper, under <channel>.
    const channel = asRecord(root.channel);
    if (channel) roots.push(channel);
  }
  for (const root of roots) {
    const found = root.item ?? root.entry;
    if (found == null) continue;
    const list = Array.isArray(found) ? found : [found];
    return list.map(asRecord).filter((e): e is Record<string, unknown> => e !== null);
  }
  return [];
}

// Parse a feed document into at most `cap` headlines. Entries with no title are
// dropped — a headline the DJ cannot read is not a headline.
export function parseFeed(xml: string, cap: number): Headline[] {
  let doc: Record<string, unknown> | null = null;
  try {
    doc = asRecord(parser.parse(xml));
  } catch {
    // Malformed XML — treat it as an empty feed rather than throwing into the
    // segment director, which is what the regex scanner did by construction.
    return [];
  }
  if (!doc) return [];

  const out: Headline[] = [];
  for (const entry of entriesOf(doc)) {
    if (out.length >= cap) break;
    const title = stripHtml(textOf(entry.title));
    if (!title) continue;
    // RSS carries the blurb in <description>; Atom uses <summary>, falling back
    // to <content> (which, post-removeNSPrefix, is also where RSS's
    // <content:encoded> lands).
    const description = stripHtml(textOf(entry.description ?? entry.summary ?? entry.content));
    out.push({ title, description });
  }
  return out;
}

export function hashHeadline(title: string): string {
  let h = 0;
  for (let i = 0; i < title.length; i++) h = ((h << 5) - h + title.charCodeAt(i)) | 0;
  return h.toString(36);
}

export async function fetchHeadlines({ feedUrl, maxItems }: { feedUrl?: string; maxItems?: number } = {}) {
  const url = feedUrl || config.news.feedUrl;
  const cap = maxItems || config.news.maxItems;
  // Bounded like the web-search backends. The feed URL is operator-set
  // (skills/news/SKILL.md `feed:`), so this is not an injection sink — the
  // deadline is about liveness. It runs inside the segment director on the
  // autonomous DJ path, where a hung socket would otherwise park the whole
  // segment on undici's ~300s default and eat the agent's own 45s budget many
  // times over. 15s is generous for an RSS document.
  const res = await fetchWithTimeout(url, { timeoutMs: 15_000 });
  if (!res.ok) throw new Error(`News feed HTTP ${res.status}`);
  return parseFeed(await res.text(), cap);
}
