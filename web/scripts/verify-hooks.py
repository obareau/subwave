#!/usr/bin/env python3
"""Drives the primitives converted to `usehooks-ts` (issue #1369).

`web/` has no test suite and none of this is in CI — this is the evidence for a
PR that touches one of these sites, in the same spirit as verify-forms.py and
verify-query-cache.py.

Everything here is READ-ONLY against the station: it types into search boxes,
clicks copy buttons and reads the clipboard. Nothing is saved. That is why it
carries no SUBWAVE_VERIFY_ALLOW_DESTRUCTIVE guard.

What it pins, and why each check is shaped the way it is:

  useDebounceValue  — a burst of keystrokes must collapse into exactly ONE
                      request carrying the FULL term. Asserted on the network,
                      because that is the property the debounce exists for.
                      Clearing the Browse box is asserted on the RENDERED rows
                      instead: the unfiltered query is already in the TanStack
                      cache (staleTime 30s), so a cache hit with no request is
                      the correct outcome there.
  useCopyToClipboard— the text really lands on the clipboard (read back), and
                      the toast/label feedback each site drives off the
                      returned boolean still fires.
  useInterval       — every consumer formats useClock to the minute, so a tick
                      is not observable in wall time. Playwright's clock
                      emulation fast-forwards 5 minutes: a stalled interval
                      would leave the rendered minute where it was.
  useMediaQuery     — phone-width viewport drives the sidebar into its sheet.

Prerequisites (per the `verify` skill — never point this at a real station):

    cd <worktree>/controller
    STATE_DIR=<tmp>/state PORT=7795 ADMIN_USER=test ADMIN_PASS=test \
      NODE_ENV=development NAVIDROME_URL=http://localhost:9999 \
      NAVIDROME_USER=x NAVIDROME_PASS=x npx tsx src/server.ts

    cd <worktree>/web
    NEXT_PUBLIC_API_URL=http://localhost:7795 npx next dev -p 7796

The Browse checks need rows in the isolated state dir's library.db; copy one in
(`cp state/library.db <tmp>/state/`) and set LIBRARY_TOTAL to its track count.
Everything else runs against an empty one.
"""
import base64
import os
import re
import sys

from playwright.sync_api import sync_playwright

WEB = os.environ.get("VERIFY_WEB", "http://localhost:7796")
API = os.environ.get("VERIFY_API", "http://localhost:7795")
AUTH = base64.b64encode(b"test:test").decode()
# Formatted with a thousands separator by the Browse tab's counter.
LIBRARY_TOTAL = os.environ.get("LIBRARY_TOTAL", "1,413")

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}  {detail}")


def debounced_searches(page, seen: list[str]) -> None:
    """The four search boxes converted to useDebounceValue."""

    def hits(fragment: str, since: int) -> list[str]:
        return [u for u in seen[since:] if fragment in u]

    # ---- Library → Browse tab ----
    page.goto(f"{WEB}/admin/library", wait_until="networkidle")
    page.wait_for_timeout(1500)
    page.get_by_text("BROWSE", exact=False).first.click()  # defaults to Tracks
    page.wait_for_timeout(1500)

    box = page.locator('input[placeholder*="filter results" i]').first
    box.wait_for(state="visible", timeout=15000)
    page.wait_for_function(
        "(total) => document.querySelector('main')?.innerText.includes('of ' + total)",
        arg=LIBRARY_TOTAL,
        timeout=15000,
    )
    check("browse: unfiltered list shows the whole library", True, f"'of {LIBRARY_TOTAL}'")

    mark = len(seen)
    box.click()
    page.keyboard.type("love", delay=40)  # 4 fast keystrokes
    page.wait_for_timeout(1200)
    with_q = [u for u in hits("/library/browse", mark) if "q=" in u]
    check(
        "browse: burst of keystrokes collapses to one debounced request",
        len(with_q) == 1,
        f"{len(with_q)} q-carrying calls: {[u.split('?')[1][:60] for u in with_q]}",
    )
    check(
        "browse: the one request carries the FULL typed term",
        any("q=love" in u for u in with_q),
        str(with_q),
    )
    check(
        "browse: the debounced term actually filters the rendered list",
        "of 53" in page.locator("main").inner_text(),
        "'1–50 of 53'",
    )

    box.fill("")
    page.wait_for_timeout(1200)
    check(
        "browse: clearing the box returns the unfiltered list",
        f"of {LIBRARY_TOTAL}" in page.locator("main").inner_text(),
        f"back to 'of {LIBRARY_TOTAL}'",
    )

    # ---- Playlist Builder: seed + artist boxes ----
    page.goto(f"{WEB}/admin/playlists", wait_until="networkidle")
    page.wait_for_timeout(1500)

    seed = page.locator('input[placeholder*="anchor on" i]').first
    seed.wait_for(state="visible", timeout=15000)
    mark = len(seen)
    seed.click()
    page.keyboard.type("radiohead", delay=40)
    page.wait_for_timeout(1200)
    searches = hits("/dj/search", mark)
    check(
        "playlist seed: burst of keystrokes collapses to one debounced search",
        len(searches) == 1,
        f"{len(searches)} calls: {[u.split('?')[1][:50] for u in searches]}",
    )
    check(
        "playlist seed: the search carries the FULL typed term",
        any("q=radiohead" in u for u in searches),
        str(searches),
    )

    # The under-two-characters guard reads the RAW query, so it must not search.
    mark = len(seen)
    seed.fill("")
    seed.type("r", delay=40)
    page.wait_for_timeout(900)
    check(
        "playlist seed: a one-character query fires no search",
        len(hits("/dj/search", mark)) == 0,
        f"{len(hits('/dj/search', mark))} calls",
    )

    artist = page.locator('input[placeholder*="Add an artist" i]').first
    artist.wait_for(state="visible", timeout=15000)
    mark = len(seen)
    artist.click()
    page.keyboard.type("portishead", delay=40)
    page.wait_for_timeout(1200)
    art = hits("/dj/search", mark)
    check(
        "playlist artist filter: burst collapses to one debounced search",
        len(art) == 1 and "q=portishead" in art[0],
        f"{len(art)} calls: {[u.split('?')[1][:50] for u in art]}",
    )


def clipboard_sites(page) -> None:
    """The first-party sites converted to useCopyToClipboard."""
    # ---- CodeBlock, on a public /setup page ----
    page.goto(f"{WEB}/setup/quick-start", wait_until="networkidle")
    page.wait_for_timeout(800)
    copy_btn = page.locator("button.bs-copy").first
    copy_btn.wait_for(state="visible", timeout=15000)
    expected = page.locator("pre.bs-code").first.locator("code").inner_text().strip()
    copy_btn.click()
    page.wait_for_timeout(400)
    clip = page.evaluate("navigator.clipboard.readText()")
    check("CodeBlock: copies the block's text", clip.strip() == expected,
          f"{clip[:45]!r} vs {expected[:45]!r}")
    # inner_text is the RENDERED text and .bs-copy is CSS-uppercased.
    check("CodeBlock: button flips to Copied",
          copy_btn.inner_text().strip().lower() == "copied", repr(copy_btn.inner_text().strip()))
    page.wait_for_timeout(1600)
    check("CodeBlock: label reverts after ~1.4s",
          copy_btn.inner_text().strip().lower() == "copy", repr(copy_btn.inner_text().strip()))

    # ---- Connect → Integrations (CopyUrl) ----
    page.goto(f"{WEB}/admin/connect", wait_until="networkidle")
    page.wait_for_timeout(1500)
    page.get_by_text("Integrations", exact=False).first.click()
    page.wait_for_timeout(1200)
    url_btn = page.get_by_role("button", name=re.compile(r"^Copy$", re.I)).first
    url_btn.wait_for(state="visible", timeout=15000)
    page.evaluate("navigator.clipboard.writeText('')")
    url_btn.click()
    page.wait_for_timeout(500)
    clip = page.evaluate("navigator.clipboard.readText()")
    check("Connect CopyUrl: copies a station URL", clip.startswith("http"), repr(clip[:60]))
    check("Connect CopyUrl: shows the success toast",
          "copied" in page.locator("body").inner_text().lower(), "")

    # ---- Connect → Endpoints (EndpointCard's curl), inside a <details> ----
    page.get_by_text("Endpoints", exact=False).first.click()
    page.wait_for_timeout(1000)
    page.locator("details summary").first.click()
    page.wait_for_timeout(600)
    curl_btn = page.get_by_role("button", name=re.compile("copy as curl", re.I)).first
    curl_btn.wait_for(state="visible", timeout=15000)
    page.evaluate("navigator.clipboard.writeText('')")
    curl_btn.click()
    page.wait_for_timeout(500)
    clip = page.evaluate("navigator.clipboard.readText()")
    check("EndpointCard: copies a curl command", clip.startswith("curl"), repr(clip[:70]))
    check("EndpointCard: shows the curl toast",
          "curl copied" in page.locator("body").inner_text().lower(), "")

    # ---- DJ Doc: the report copy ----
    page.goto(f"{WEB}/admin/doctor", wait_until="networkidle")
    page.wait_for_timeout(2000)
    run = page.get_by_role("button", name=re.compile(r"let'?s go|run|assess", re.I)).first
    run.wait_for(state="visible", timeout=15000)
    run.click()
    doc_copy = page.get_by_role("button", name=re.compile("copy", re.I)).first
    doc_copy.wait_for(state="visible", timeout=120000)  # a full stack assessment
    page.evaluate("navigator.clipboard.writeText('')")
    doc_copy.click()
    page.wait_for_timeout(600)
    clip = page.evaluate("navigator.clipboard.readText()")
    check("DoctorPanel: copies the markdown report",
          clip.startswith("## SUB/WAVE diagnostics") and "Generated" in clip,
          f"{len(clip)} chars")
    check("DoctorPanel: shows the success toast",
          "copied" in page.locator("body").inner_text().lower(), "")


def clock_and_media_query(ctx, page) -> None:
    # useClock reaches the UI as turnClock's HH:MM (tty / subamp / drift skins).
    clocked = ctx.new_page()
    clocked.clock.install(time="2026-08-12T09:15:00")
    clocked.add_init_script("localStorage.setItem('subwave-skin-override', 'tty')")
    clocked.goto(f"{WEB}/listen", wait_until="networkidle")
    clocked.wait_for_timeout(1500)
    before = re.search(r"\d{1,2}:\d{2}", clocked.locator("body").inner_text())
    check("useClock: the tty skin renders a wall clock", bool(before),
          before.group(0) if before else "none")
    clocked.clock.fast_forward("05:00")
    clocked.wait_for_timeout(500)
    after = re.search(r"\d{1,2}:\d{2}", clocked.locator("body").inner_text())
    check(
        "useClock: keeps ticking under useInterval",
        bool(before and after) and before.group(0) != after.group(0),
        f"{before.group(0) if before else None} -> {after.group(0) if after else None}",
    )
    clocked.close()

    # useMediaQuery drives the sidebar's mobile sheet.
    page.set_viewport_size({"width": 480, "height": 900})
    page.goto(f"{WEB}/admin", wait_until="networkidle")
    page.wait_for_timeout(1500)
    page.get_by_role("button", name=re.compile("toggle sidebar", re.I)).first.click()
    page.wait_for_timeout(900)
    check(
        "useIsMobile: phone width opens the sidebar as a sheet",
        page.locator('[data-mobile="true"]').count() > 0,
        f'{page.locator("[data-mobile=\'true\']").count()} sheet nodes',
    )


def main() -> int:
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        ctx = browser.new_context(
            viewport={"width": 1400, "height": 950},
            permissions=["clipboard-read", "clipboard-write"],
        )
        ctx.add_init_script(f"localStorage.setItem('subwave_admin_auth', '{AUTH}')")
        page = ctx.new_page()

        seen: list[str] = []
        errors: list[str] = []
        page.on("request", lambda r: seen.append(r.url))
        page.on("pageerror", lambda e: errors.append(str(e)))

        debounced_searches(page, seen)
        clipboard_sites(page)
        clock_and_media_query(ctx, page)
        check("no uncaught page errors across the run", not errors, "; ".join(errors[:2]))

        browser.close()

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    print(f"web={WEB} api={API}")
    sys.exit(main())
