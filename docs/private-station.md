# Private station mode

SUB/WAVE is public by default: anyone with the address can open the player and
anyone who guesses `/stream.mp3` can listen. If you'd rather keep your station
to yourself (issue #478), **admin → Settings → Station → Privacy** gives you
two independent locks.

Both locks share **one station password**, set in the same place. Turning on
either lock requires a password first.

## Private player (UI lock)

Swaps the public web pages (`/`, `/listen`) for a password prompt. Type the
station password and the player appears as normal; the browser remembers it.
`/admin` and `/onboarding` keep working (the admin console keeps its own
separate sign-in). Applies live — no restart.

This only hides the interface. The now-playing JSON endpoints stay public
(the player and admin dash rely on them), and the stream URL still works —
for actual gating you want the stream password too.

## Stream password (the real boundary)

Turns on Icecast listener authentication for every mount (`/stream.mp3`,
`/stream.opus`, `/stream.flac`, `/stream.aac`). The same station password, for
all listeners — Icecast only speaks HTTP basic auth, so there are no per-user
accounts (and no OIDC; that's not viable for a live audio stream).

How it works under the hood: the controller writes
`state/icecast_listener_auth.txt`, and on the next broadcast restart the
Icecast config gains per-mount `<authentication type="url">` blocks pointing
at the controller's `POST /listener-auth`. Icecast asks the controller on
every listener connect, so:

- **Enabling/disabling needs a mixer restart** (the admin UI tells you, same
  as the Opus/AAC toggles).
- **Password changes apply live** — the controller validates each connect
  against the current settings.
- **If the controller is down, new listeners can't connect** (fail closed);
  already-connected listeners keep playing.

> **Running your own reverse proxy?** `POST /listener-auth` answers 200 or 401
> depending on whether the submitted password is right, which makes it a
> password oracle for anyone who can reach it — and it's the *same* password
> that guards the private player. Icecast always calls the controller directly
> over the internal network, so the endpoint never needs to be reachable from
> the internet. The bundled Caddy config returns 404 for
> `/api/listener-auth`; if you use `docker-compose.byo.yml` with your own
> Traefik/nginx/Caddy, block that path too. The controller slows repeated
> failed attempts as a backstop (correct passwords are never delayed), but
> not exposing the path at all is the real protection.

### Tuning in with a password

- **Web player** — asks for the password once and remembers it in the
  browser. If the private player is on too, the single prompt unlocks both the
  interface and the audio. Under the hood it rides a `?auth=PASSWORD` token on
  the stream URL (browsers can't attach basic auth to an `<audio>` element).
- **Radio apps / VLC / Sonos / hardware** — use a credentialed URL:
  `https://listener:PASSWORD@your-station.example/stream.mp3`
  (any username works; only the password is checked).
- **Anything that can't do userinfo URLs** — append the token instead:
  `https://your-station.example/stream.mp3?auth=PASSWORD`.
- **Native app** — add the credentials to the station address
  (`https://listener:PASSWORD@your-station.example`); the app converts them
  into a stream `Authorization` header automatically.

While the password is on, `/listen.pls` and `/listen.m3u` return 403 — they
would otherwise hand out credential-less URLs that no longer play.

## A different thing: HTTP Basic Auth in front of the whole station

Everything above is SUB/WAVE's *own* privacy lock. Plenty of operators instead
put **HTTP Basic Auth on the reverse proxy** (nginx `auth_basic`, Caddy
`basic_auth`, Traefik's `BasicAuth` middleware), which gates the admin UI, the
player, the API and the streams in one go — before a request ever reaches the
controller.

> Identity proxies like **Cloudflare Access** are a different mechanism and are
> **not** supported by the apps: they authenticate with an SSO session cookie
> (or `CF-Access-Client-*` service-token headers), not HTTP Basic Auth, so
> there is no `user:pass@` form to type. Everything below is about plain basic
> auth.

Plain basic auth works, and the mobile apps support it. The credential form is
the same:

```
https://dj:secret@radio.yourhost.com
```

Enter that as the **station address** (iOS and Android; on the add-station
screen just type `dj:secret@radio.yourhost.com`). From there the app takes two
different routes with the same credentials, which is worth knowing when
something half-works:

- **API polls and cover artwork** keep the credentials **on the URL**. RN's
  `fetch` and `<Image>` sit on NSURLSession / OkHttp, which answer the server's
  basic-auth challenge from the userinfo themselves — nothing to do.
- **The audio stream** gets a credential-free URL plus an explicit
  `Authorization: Basic` header, because **iOS's AVPlayer silently drops
  `user:pass@` userinfo from a media URL** (and Android's player is no more
  reliable about it). That is why a basic-auth station could report *Stream
  Unreachable* / HTTP 401 in the app while the exact same URL played fine in a
  browser, in VLC and via `curl` (#764).

Three things to know:

- **The URL is stored as you typed it**, credentials included, in the app's
  saved-stations list. It's a shared listening password, not an account —
  don't reuse a password that matters.
- **Google Cast is unavailable** for a station whose address carries
  credentials (the cast button doesn't appear). A Chromecast fetches the stream
  itself, and it has no way to send the header — this applies to SUB/WAVE's own
  stream password too, since that also travels as userinfo.
- **An `@` in the password must be percent-encoded** as `%40`. The app cuts the
  userinfo at the first `@`, so an unencoded one takes part of the hostname
  with it and the address silently points somewhere else. A `:` is only a
  problem in the **username** (`%3A`) — the split is on the first colon, so a
  password may contain them freely.

Percent-encoded values are decoded before the credentials are used, so
`dj:p%40ss@radio.example` authenticates as `dj` / `p@ss`.

Basic auth on the proxy and SUB/WAVE's own stream password are independent and
can be combined, but there's rarely a reason to: the proxy lock is broader
(it covers admin too) while the stream password is what lets you hand a
listener the stream without handing them the console.

## Known limits

- One shared password for both locks; rotating it logs every listener out
  (web listeners get re-prompted automatically).
- Metadata endpoints (`/api/now-playing`, `/api/state`) stay public.
- The landing broadsheet (`/landing`) is not gated — it exists to market a
  station, which is at odds with private mode; leave `SUBWAVE_HOMEPAGE=player`
  (the default) on a private install.
- The `?auth=` token appears in Icecast's access log on your own box.
