#!/usr/bin/env bash
# SUB/WAVE all-in-one supervisor.
#
# Runs the whole stack — icecast2 + liquidsoap (the broadcast pair), the
# controller, the Next.js web UI, and Caddy — inside ONE container for the
# Unraid Community Applications one-click image (docker/Dockerfile.aio).
#
# The split-stack deployment runs these as five compose services wired over an
# internal network; here they all share localhost and the /var/sub-wave volume,
# so the file-based IPC (next.txt / say.txt / now-playing.json …) works exactly
# as before with no code changes — only a handful of *_HOST/*_URL env overrides
# repoint the controller at loopback.
#
# Each service runs in its own restart loop, so a web or controller crash does
# NOT take the station off the air. The icecast+liquidsoap pair is launched as a
# unit (mirroring docker/broadcast-entrypoint.sh): if either dies the pair is
# bounced together, because liquidsoap is useless without its icecast sink.
#
# Bash (not /bin/sh) for `wait -n`; the savonet/liquidsoap base ships bash.
set -u

SECRETS=/var/sub-wave/icecast-secrets.env
TEMPLATE=/etc/icecast2/icecast.xml.template
RENDERED=/etc/icecast2/icecast.xml

# Multi-station pointer (see docker/broadcast-entrypoint.sh — kept in lockstep).
# Called at the top of run_broadcast so every mixer relaunch re-resolves.
#
# Both paths are env-overridable so scripts/aio-log-link.test.ts can drive
# link_liquidsoap_log() against a scratch dir. Neither var is set in the image,
# so the container resolves the same literals it always did.
STATE_ROOT="${SUBWAVE_STATE_ROOT:-/var/sub-wave}"
LIQ_LOG_DIR="${SUBWAVE_LIQ_LOG_DIR:-/var/log/liquidsoap}"
STATE_DIR="$STATE_ROOT"
resolve_state_dir() {
	STATE_DIR="$STATE_ROOT"
	local active="$STATE_ROOT/stations/active.json" id=""
	if [ -f "$active" ]; then
		id=$(sed -n 's/.*"activeId"[[:space:]]*:[[:space:]]*"\([a-z0-9][a-z0-9-]\{0,40\}\)".*/\1/p' "$active" | head -n1)
		if [ -n "$id" ] && [ -d "$STATE_ROOT/stations/$id" ]; then
			STATE_DIR="$STATE_ROOT/stations/$id"
			log "active station '$id' → $STATE_DIR"
		else
			log "WARNING stations/active.json unresolvable (id='$id') — using root"
		fi
	fi
	export SUBWAVE_STATE_DIR="$STATE_DIR"
}

log() { echo "[subwave-aio] $*" >&2; }

# ---------------------------------------------------------------------------
# One-time state bootstrap — shared dirs, watch-mode m3u stubs, archive ignore.
# Same responsibilities as docker/broadcast-entrypoint.sh, minus launching the
# audio processes (the supervisor does that in a restart loop below). Mode 777
# because the services run under different uids (icecast2 / liquidsoap / root).
# ---------------------------------------------------------------------------
init_state() {
	mkdir -p /var/sub-wave \
	         /var/sub-wave/voice \
	         /var/sub-wave/voices \
	         /var/sub-wave/archive \
	         /var/sub-wave/jingles \
	         /var/sub-wave/logs \
	         /var/sub-wave/sessions \
	         /var/sub-wave/sfx
	chmod 777 /var/sub-wave \
	          /var/sub-wave/voice \
	          /var/sub-wave/voices \
	          /var/sub-wave/archive \
	          /var/sub-wave/jingles \
	          /var/sub-wave/logs \
	          /var/sub-wave/sessions \
	          /var/sub-wave/sfx

	# Liquidsoap's reload_mode="watch" playlists need the files to exist.
	touch /var/sub-wave/auto.m3u /var/sub-wave/jingles.m3u
	chmod 666 /var/sub-wave/auto.m3u /var/sub-wave/jingles.m3u

	# Keep a co-located Navidrome from scanning the station's own hourly
	# archive mixdowns as junk "HH-00" tracks (issue #273).
	touch /var/sub-wave/archive/.ndignore

	link_liquidsoap_log

	# Rotate radio.log on boot once it passes 50MB — same policy (and same
	# container-side path) as docker/broadcast-entrypoint.sh. Now that the
	# log persists in state, it would otherwise append forever; boot is the
	# one safe moment to move it since liquidsoap isn't holding the fd yet.
	# One .old generation caps disk at ~2x the threshold. Rotating via
	# $LIQ_LOG_DIR (not $STATE_ROOT/logs) matters: after
	# link_liquidsoap_log it resolves to wherever radio.log actually lands —
	# state logs, an operator's own disk, a bind mount, or the local
	# fallback — while the state path misses the last two branches.
	RADIO_LOG="$LIQ_LOG_DIR/radio.log"
	if [ -f "$RADIO_LOG" ] && [ "$(stat -c %s "$RADIO_LOG" 2>/dev/null || echo 0)" -gt 52428800 ]; then
		mv -f "$RADIO_LOG" "$RADIO_LOG.old"
		echo "supervisor: rotated oversized radio.log to radio.log.old" >&2
	fi
}

# ---------------------------------------------------------------------------
# Point /var/log/liquidsoap at the state ROOT's logs/, but never at the cost of
# the station.
#
# radio.liq opens settings.log.file.path during Dtools.Log.init — the FIRST
# lifecycle step, before the mixer graph, before the telnet port, before the
# Icecast connection. An unopenable log path is therefore not a degraded log,
# it is a fatal startup error. That makes this the one bootstrap step that can
# take the station off the air, so it fails soft: every branch below ends with
# a path liquidsoap can actually open, verified by probe rather than assumed.
#
# The goal is still #1196's — radio.log has to survive container recreates and
# routes/debug.ts tails <stateRoot>/logs/radio.log, the same install-level
# location the compose stacks pin via their ${STATE_DIR}/logs bind mount.
#
# What #1196 got wrong: it created the symlink unconditionally and guarded
# re-entry on `[ ! -L /var/log/liquidsoap ]`. If <state>/logs was itself a
# symlink pointing back at /var/log/liquidsoap — the natural host-side
# workaround for the pre-#1196 "AIO has no radio.log in the state dir" bug —
# the two links closed a cycle and every start died with
#
#   Fatal error: exception Sys_error("/var/log/liquidsoap/radio.log: Too many
#   levels of symbolic links")
#
# and because the guard only tested -L, it then SKIPPED (never repaired) the
# bad link on every subsequent boot: an unbreakable 3s crash loop, both Doctor
# broadcast checks red, and the "Restart mixer" fix button useless because it
# speaks telnet to a port liquidsoap never got far enough to bind.
# ---------------------------------------------------------------------------
link_liquidsoap_log() {
	local target="$STATE_ROOT/logs"

	# 1. Heal a broken state-side logs link. `-d` is false for a dangling
	#    symlink AND for a looping one (stat fails with ELOOP), which is
	#    exactly the set worth replacing with a real directory. A symlink
	#    that resolves to a real directory elsewhere is an operator parking
	#    logs on another disk on purpose — left alone.
	if [ -L "$target" ] && [ ! -d "$target" ]; then
		log "WARNING $target is a broken symlink (-> $(readlink "$target" 2>/dev/null || echo '?')) — replacing it with a real directory"
		rm -f "$target" 2>/dev/null || true
	fi

	# 1b. A state-side link that RESOLVES INTO the container log path is the
	#     #1196 cycle half wearing a disguise: it only looks healthy while
	#     the fresh image's plain /var/log/liquidsoap still exists (the
	#     exact shape the reported operator's install boots into after
	#     pulling this fix). Linking $LIQ_LOG_DIR at a path that resolves to
	#     $LIQ_LOG_DIR itself can only re-create the cycle, which the probe
	#     below would then break — but at the price of dropping persistence.
	#     Replacing the link with a real directory now keeps it.
	if [ -L "$target" ] && [ -d "$target" ] && command -v realpath >/dev/null 2>&1; then
		local target_real liq_real
		target_real=$(realpath -m -- "$target" 2>/dev/null || true)
		liq_real=$(realpath -m -- "$LIQ_LOG_DIR" 2>/dev/null || true)
		if [ -n "$target_real" ] && [ "$target_real" = "$liq_real" ]; then
			log "WARNING $target resolves into $LIQ_LOG_DIR — the #1196 cycle half; replacing it with a real directory"
			rm -f "$target" 2>/dev/null || true
		fi
	fi

	mkdir -p "$target" 2>/dev/null || true
	chmod 777 "$target" 2>/dev/null || true

	# 2. Point the in-container path at it — unless something is mounted
	#    there. An operator who bind-mounted a host dir onto
	#    /var/log/liquidsoap (the split stack's compose mapping, copied into
	#    an AIO `docker run`) already has a persistent log dir, so it is
	#    used as-is. The mountpoint test must come BEFORE any `rm -rf`:
	#    `rm -rf` on a mountpoint can't remove the mountpoint itself but
	#    DOES delete everything inside it — which would wipe the very log
	#    history the operator mounted the dir to keep, on every boot.
	if [ -d "$target" ]; then
		if [ -e "$LIQ_LOG_DIR" ] && [ ! -L "$LIQ_LOG_DIR" ] && is_mountpoint "$LIQ_LOG_DIR"; then
			log "$LIQ_LOG_DIR is a mountpoint — leaving it as-is; radio.log stays there"
		else
			# Anything unmounted at the container path — a plain dir
			# from a pre-#1196 image, a stray file — is replaced by
			# the link. `ln -s` onto a surviving directory would
			# silently create the link INSIDE it
			# (/var/log/liquidsoap/logs), hence the rm first.
			[ -L "$LIQ_LOG_DIR" ] || rm -rf "$LIQ_LOG_DIR" 2>/dev/null || true
			if [ -e "$LIQ_LOG_DIR" ] && [ ! -L "$LIQ_LOG_DIR" ]; then
				# Unremovable yet not detected as a mountpoint
				# (exotic mount setups) — same outcome, use as-is.
				log "$LIQ_LOG_DIR survived removal (bind mount?) — leaving it; radio.log stays there"
			else
				# -f replaces an existing link (including a looping one, which
				# is removed rather than followed); -n keeps it from being
				# planted inside a link-to-directory.
				ln -sfn "$target" "$LIQ_LOG_DIR" 2>/dev/null || true
			fi
		fi
	else
		log "WARNING $target is not a usable directory — not linking $LIQ_LOG_DIR at it"
	fi

	# 3. Prove liquidsoap can open a file there before handing over the path.
	#    This is the backstop that turns the whole ELOOP class of bug into a
	#    warning: any shape that fails the probe falls back to a plain
	#    container-local directory, which costs the Debug tail its history
	#    across recreates but keeps the station on the air.
	if ! probe_log_dir; then
		log "WARNING $LIQ_LOG_DIR is unopenable — falling back to a container-local log dir; radio.log will NOT persist in the state dir"
		# A mountpoint can be neither removed nor replaced, so rebuilding
		# is pointless there — and `rm -rf` on a mount that somehow fails
		# the probe would only strip the operator's files while leaving
		# the path just as unopenable. Rebuild unmounted paths only.
		if ! is_mountpoint "$LIQ_LOG_DIR"; then
			rm -rf "$LIQ_LOG_DIR" 2>/dev/null || true
			mkdir -p "$LIQ_LOG_DIR" 2>/dev/null || true
		fi
		probe_log_dir || log "ERROR $LIQ_LOG_DIR is still unopenable — liquidsoap will fail to start"
	fi

	# Both follow the link to whatever directory we settled on. Deliberately
	# NOT recursive: liquidsoap only needs to create/append radio.log in the
	# directory itself, and an operator who pointed <state>/logs at their own
	# disk shouldn't have its existing contents re-owned underneath them.
	# The directory inode itself IS re-moded/re-owned even when it is the
	# operator's own — that's the price of liquidsoap being able to create
	# radio.log inside it; only the contents are left untouched.
	chmod 777 "$LIQ_LOG_DIR" 2>/dev/null || true
	chown liquidsoap:liquidsoap "$LIQ_LOG_DIR" 2>/dev/null || true
}

# Can a file actually be created under $LIQ_LOG_DIR? Runs as root, so it proves
# the PATH resolves (the ELOOP/dangling class) rather than that the liquidsoap
# user has write permission — that part is the chmod/chown at the end of
# link_liquidsoap_log.
probe_log_dir() {
	local probe="$LIQ_LOG_DIR/.write-probe"
	: > "$probe" 2>/dev/null || return 1
	rm -f "$probe" 2>/dev/null || true
	return 0
}

# Is $1 a mountpoint? `mountpoint` ships with util-linux on the Debian base;
# fall back to /proc/self/mountinfo (field 5 is the mount point) so the answer
# never silently degrades to "not a mount" just because the binary is missing.
# A symlink is never its own mountpoint, but `mountpoint` resolves it and
# reports on the target — fine for both call sites, which only ask about
# non-symlink shapes or paths about to be rebuilt anyway.
is_mountpoint() {
	if command -v mountpoint >/dev/null 2>&1; then
		mountpoint -q "$1" 2>/dev/null
	else
		awk -v p="$1" '$5 == p { found = 1; exit } END { exit found ? 0 : 1 }' /proc/self/mountinfo 2>/dev/null
	fi
}

# ---------------------------------------------------------------------------
# Warn loudly if the state dir isn't a mounted volume. With no host path (or
# volume) mapped to /var/sub-wave, everything the station writes — settings,
# library.db with the acoustic analysis, hourly archives, the model cache —
# lives in the container's throwaway writable layer, and the next image update
# (which recreates the container) silently wipes it. The Unraid CA template maps
# this as a required Appdata path; a bare `docker run` that forgets `-v` is the
# footgun this catches (issue #902). A real bind/volume mount gets its own entry
# in /proc/mounts at the target path; an un-mapped dir on the overlay fs doesn't.
# ---------------------------------------------------------------------------
warn_if_state_unmounted() {
	if ! grep -q ' /var/sub-wave ' /proc/mounts 2>/dev/null; then
		log "################################################################"
		log "WARNING: /var/sub-wave is NOT a mounted volume."
		log "  Your settings, library cache (library.db), hourly archives and"
		log "  model cache are being written into the container's writable"
		log "  layer, and will be LOST the next time this image is updated."
		log "  Map a host path to /var/sub-wave (on Unraid: the Appdata path,"
		log "  e.g. /mnt/user/appdata/subwave) and recreate the container."
		log "  https://github.com/perminder-klair/subwave/issues/902"
		log "################################################################"
	fi
}

# ---------------------------------------------------------------------------
# Resolve the three ICECAST_*_PASSWORD values and render icecast.xml.
# Precedence (unchanged from broadcast-entrypoint): env override > persisted
# state/icecast-secrets.env > freshly generated. Resolved values are exported
# (liquidsoap reads ICECAST_SOURCE_PASSWORD from the environment) and written
# back to the secrets file for operator visibility + the documented rotate path.
# ---------------------------------------------------------------------------
init_secrets() {
	local ENV_SRC="${ICECAST_SOURCE_PASSWORD:-}"
	local ENV_ADM="${ICECAST_ADMIN_PASSWORD:-}"
	local ENV_REL="${ICECAST_RELAY_PASSWORD:-}"

	if [ -f "$SECRETS" ]; then
		# shellcheck disable=SC1090
		. "$SECRETS"
	fi

	[ -n "$ENV_SRC" ] && ICECAST_SOURCE_PASSWORD="$ENV_SRC"
	[ -n "$ENV_ADM" ] && ICECAST_ADMIN_PASSWORD="$ENV_ADM"
	[ -n "$ENV_REL" ] && ICECAST_RELAY_PASSWORD="$ENV_REL"

	[ -z "${ICECAST_SOURCE_PASSWORD:-}" ] && ICECAST_SOURCE_PASSWORD="$(openssl rand -hex 16)"
	[ -z "${ICECAST_ADMIN_PASSWORD:-}"  ] && ICECAST_ADMIN_PASSWORD="$(openssl rand -hex 16)"
	[ -z "${ICECAST_RELAY_PASSWORD:-}"  ] && ICECAST_RELAY_PASSWORD="$(openssl rand -hex 16)"

	cat > "$SECRETS" <<-EOF
		ICECAST_SOURCE_PASSWORD=$ICECAST_SOURCE_PASSWORD
		ICECAST_ADMIN_PASSWORD=$ICECAST_ADMIN_PASSWORD
		ICECAST_RELAY_PASSWORD=$ICECAST_RELAY_PASSWORD
	EOF
	# 0600: holds the Icecast passwords, read only by root (this supervisor
	# sources it, and the in-process controller reads it off the state dir —
	# all root in the AIO's single container). Keep it owner-only.
	chmod 600 "$SECRETS"

	export ICECAST_SOURCE_PASSWORD ICECAST_ADMIN_PASSWORD ICECAST_RELAY_PASSWORD
	# Liquidsoap connects to icecast over loopback inside this container;
	# radio.liq reads ICECAST_HOST (default "icecast").
	export ICECAST_HOST=localhost
}

# ---------------------------------------------------------------------------
# Render icecast.xml from the template + resolved secrets. Called on EVERY
# broadcast pair (re)launch — not just boot — so a restart-mixer picks up a
# flipped listener-auth flag (or a changed buffer/bitrate setting) the same
# way the split stack's container restart re-runs its entrypoint.
# ---------------------------------------------------------------------------
read_state_num() {
	# $1 = filename under $STATE_DIR, $2 = fallback. Non-numeric/missing → fallback.
	local _v
	_v=$(cat "$STATE_DIR/$1" 2>/dev/null || true)
	case "$_v" in
		''|*[!0-9]*) echo "$2" ;;
		*) echo "$_v" ;;
	esac
}

render_icecast() {
	# Concurrent-listener ceiling (<limits><clients>). Empty/unset → the stock 100.
	# A non-numeric value would render invalid XML and fail icecast at boot,
	# so fall back to the default with a warning instead.
	ICECAST_MAX_CLIENTS="${ICECAST_MAX_CLIENTS:-100}"
	case "$ICECAST_MAX_CLIENTS" in
		*[!0-9]*|'')
			log "ICECAST_MAX_CLIENTS='$ICECAST_MAX_CLIENTS' is not a number — using 100"
			ICECAST_MAX_CLIENTS=100
			;;
	esac

	# Listener buffer depth — same contract as docker/broadcast-entrypoint.sh
	# (#1114): burst-size is a byte count, so it's derived from
	# settings.stream.bufferSeconds x each mount's bitrate. Re-read on every
	# pair launch so a settings change lands after a restart-mixer.
	local STREAM_BITRATE BUFFER_SECONDS OPUS_BITRATE AAC_BITRATE FLAC_BITRATE_EST
	STREAM_BITRATE="${ICECAST_STREAM_BITRATE:-$(read_state_num liquidsoap_stream_bitrate.txt 192)}"
	BUFFER_SECONDS="${ICECAST_BUFFER_SECONDS:-$(read_state_num liquidsoap_stream_buffer_seconds.txt 22)}"
	case "$STREAM_BITRATE" in *[!0-9]*|'') STREAM_BITRATE=192 ;; esac
	case "$BUFFER_SECONDS" in *[!0-9]*|'') BUFFER_SECONDS=22 ;; esac
	[ "$BUFFER_SECONDS" -gt 60 ] && BUFFER_SECONDS=60
	OPUS_BITRATE="${ICECAST_OPUS_BITRATE:-$(read_state_num liquidsoap_opus_bitrate.txt 96)}"
	AAC_BITRATE="${ICECAST_AAC_BITRATE:-$(read_state_num liquidsoap_aac_bitrate.txt 192)}"
	case "$OPUS_BITRATE" in *[!0-9]*|'') OPUS_BITRATE=96 ;; esac
	case "$AAC_BITRATE" in *[!0-9]*|'') AAC_BITRATE=192 ;; esac
	# FLAC is VBR — ~900 kbps is a typical average for 44.1/16 stereo.
	FLAC_BITRATE_EST=900

	# Global <limits> fallback, sized for the MP3 mount (kbps x 125 = bytes/s).
	local ICECAST_BURST_SIZE ICECAST_QUEUE_SIZE
	ICECAST_BURST_SIZE=$(( BUFFER_SECONDS * STREAM_BITRATE * 125 ))
	ICECAST_QUEUE_SIZE=$(( ICECAST_BURST_SIZE * 4 ))
	[ "$ICECAST_QUEUE_SIZE" -lt 2097152 ] && ICECAST_QUEUE_SIZE=2097152
	log "listener buffer ${BUFFER_SECONDS}s @ mp3 ${STREAM_BITRATE}kbps / opus ${OPUS_BITRATE}kbps / aac ${AAC_BITRATE}kbps / flac ~${FLAC_BITRATE_EST}kbps"

	# Listener auth (#478) — same contract as docker/broadcast-entrypoint.sh:
	# only a literal 'true' in the controller-written flag file enables, and
	# each stream mount then gets an <authentication type="url"> block. The
	# controller runs in-process here, so the callback goes over loopback.
	local FLAG=$STATE_DIR/icecast_listener_auth.txt
	local AUTH_URL="${LISTENER_AUTH_URL:-http://localhost:7701/listener-auth}"
	local LISTENER_AUTH=false
	if [ "$(cat "$FLAG" 2>/dev/null | tr -d '[:space:]')" = "true" ]; then
		LISTENER_AUTH=true
		log "listener auth ON — mounts require credentials via $AUTH_URL"
	fi

	# One <mount> block per stream mount, ALWAYS rendered: each carries its
	# own burst/queue sized for its own bitrate (the global <limits> value
	# only fits the MP3 mount), plus the auth block when the toggle is on.
	local MOUNTS_XML=/etc/icecast2/stream-mounts.xml
	: > "$MOUNTS_XML"
	emit_mount() {
		# $1 = mount path, $2 = kbps used to size this mount's burst
		local _burst _queue
		_burst=$(( BUFFER_SECONDS * $2 * 125 ))
		_queue=$(( _burst * 4 ))
		[ "$_queue" -lt 2097152 ] && _queue=2097152
		{
			echo '    <mount type="normal">'
			echo "        <mount-name>$1</mount-name>"
			echo "        <burst-size>$_burst</burst-size>"
			echo "        <queue-size>$_queue</queue-size>"
			if [ "$LISTENER_AUTH" = true ]; then
				echo '        <authentication type="url">'
				echo "            <option name=\"listener_add\" value=\"$AUTH_URL\"/>"
				echo '            <option name="auth_header" value="icecast-auth-user: 1"/>'
				echo '        </authentication>'
			fi
			echo '    </mount>'
		} >> "$MOUNTS_XML"
	}
	emit_mount /stream.mp3  "$STREAM_BITRATE"
	emit_mount /stream.opus "$OPUS_BITRATE"
	emit_mount /stream.flac "$FLAC_BITRATE_EST"
	emit_mount /stream.aac  "$AAC_BITRATE"

	# Trusted reverse proxies — same contract as docker/broadcast-entrypoint.sh
	# (real listener IPs in admin → Listeners instead of the edge's address).
	# The AIO has it easy: Caddy is in THIS container, so the peer is always
	# loopback and the address is known without any DNS or ordering dance that
	# the split stack has to negotiate. icecast-KH wants an exact IP, and both
	# loopback forms are emitted because which one icecast sees depends on how
	# Caddy resolved its upstream. ICECAST_TRUSTED_PROXY_IPS still overrides,
	# for an AIO sitting behind a further reverse proxy that rewrites the chain.
	local TRUSTED_XML=/etc/icecast2/trusted-proxies.xml
	local TRUSTED_LIST _ip
	: > "$TRUSTED_XML"
	TRUSTED_LIST=$(echo "${ICECAST_TRUSTED_PROXY_IPS:-127.0.0.1 ::1}" | tr ',' ' ')
	for _ip in $TRUSTED_LIST; do
		case "$_ip" in
			''|*[!0-9a-fA-F.:]*)
				log "WARNING ignoring malformed trusted proxy '$_ip'"
				continue
				;;
		esac
		echo "        <x-forwarded-for>$_ip</x-forwarded-for>" >> "$TRUSTED_XML"
	done

	sed \
		-e "s|\${ICECAST_SOURCE_PASSWORD}|$ICECAST_SOURCE_PASSWORD|g" \
		-e "s|\${ICECAST_ADMIN_PASSWORD}|$ICECAST_ADMIN_PASSWORD|g" \
		-e "s|\${ICECAST_RELAY_PASSWORD}|$ICECAST_RELAY_PASSWORD|g" \
		-e "s|\${ICECAST_MAX_CLIENTS}|$ICECAST_MAX_CLIENTS|g" \
		-e "s|\${ICECAST_BURST_SIZE}|$ICECAST_BURST_SIZE|g" \
		-e "s|\${ICECAST_QUEUE_SIZE}|$ICECAST_QUEUE_SIZE|g" \
		-e "/<!--@STREAM_MOUNTS@-->/r $MOUNTS_XML" \
		-e "/<!--@STREAM_MOUNTS@-->/d" \
		-e "/<!--@TRUSTED_PROXIES@-->/r $TRUSTED_XML" \
		-e "/<!--@TRUSTED_PROXIES@-->/d" \
		"$TEMPLATE" > "$RENDERED"
	chown icecast2 "$RENDERED" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Service launchers. Each blocks until its process exits, so the supervise()
# loop can restart it. Do NOT `exec` — that would replace the loop.
# ---------------------------------------------------------------------------

# icecast2 + liquidsoap as a unit. Returns when either dies (the loop bounces
# the pair). icecast runs as the icecast2 user; liquidsoap as the liquidsoap
# user (uid 10000). `sudo -E` preserves the resolved ICECAST_* env.
run_broadcast() {
	# Re-resolve the active station on every pair launch — this is how a
	# station switch takes effect in the AIO without a container bounce (the
	# supervise loop re-runs run_broadcast after every mixer restart).
	resolve_state_dir

	# Bootstrap the resolved station dir's subdirs (mirrors init_state, but
	# scoped to $STATE_DIR — the root case is already covered by init_state at
	# boot, and a non-root station dir needs its own subdirs created here).
	mkdir -p "$STATE_DIR" \
	         "$STATE_DIR/voice" \
	         "$STATE_DIR/voices" \
	         "$STATE_DIR/archive" \
	         "$STATE_DIR/jingles" \
	         "$STATE_DIR/logs" \
	         "$STATE_DIR/sessions" \
	         "$STATE_DIR/sfx"
	chmod 777 "$STATE_DIR" \
	          "$STATE_DIR/voice" \
	          "$STATE_DIR/voices" \
	          "$STATE_DIR/archive" \
	          "$STATE_DIR/jingles" \
	          "$STATE_DIR/logs" \
	          "$STATE_DIR/sessions" \
	          "$STATE_DIR/sfx"
	touch "$STATE_DIR/auto.m3u" "$STATE_DIR/jingles.m3u"
	chmod 666 "$STATE_DIR/auto.m3u" "$STATE_DIR/jingles.m3u"
	touch "$STATE_DIR/archive/.ndignore"

	# Re-render on every pair launch so a flipped listener-auth flag lands
	# after a restart-mixer (which bounces this pair, not the container).
	render_icecast
	log "starting icecast2"
	sudo -E -u icecast2 icecast2 -n -c "$RENDERED" &
	local ic=$!

	# Give icecast a moment to accept HTTP so liquidsoap's first source
	# connect doesn't bail with "Cannot connect to remote host".
	local i
	for i in 1 2 3 4 5 6 7 8 9 10; do
		if curl -fsS http://localhost:7702/ >/dev/null 2>&1; then
			log "icecast accepting connections after ${i}s"
			break
		fi
		sleep 1
	done

	log "starting liquidsoap"
	# TEMPORARY (re-harden later): run liquidsoap as root instead of dropping to
	# the `liquidsoap` user — same reason as docker/broadcast-entrypoint.sh. The
	# savonet base bump 2.2.5 -> 2.4.4 changed that user's uid (10000 -> 100), so
	# state files persisted under /var/sub-wave by the old image became unwritable
	# to uid 100 and every on_meta write EACCES'd. Root ignores those perms.
	# Restore the privilege drop once the state files are chowned to the new uid
	# (radio.liq's settings.init.allow_root is set for the same reason).
	liquidsoap /etc/liquidsoap/radio.liq &
	local lq=$!

	wait -n "$ic" "$lq"
	local code=$?
	log "broadcast pair: a child exited ($code) — taking the other down"
	kill -TERM "$ic" "$lq" 2>/dev/null || true
	wait "$ic" "$lq" 2>/dev/null || true
	return "$code"
}

# Controller — the AI DJ brain. The *_HOST/*_URL overrides repoint it from the
# compose service names (broadcast:7702 / 1234) at loopback. DOCKER_HOST and
# TTS_HEAVY_URL are intentionally unset: the Stats system panel degrades
# gracefully and TTS falls back to the bundled Piper voice. All other config
# (Navidrome, LLM, ADMIN_*, SITE_URL, TZ) is inherited from the container env
# and the first-run wizard's settings.json.
run_controller() {
	cd /app || return 1
	export NODE_ENV=production \
	       STATE_DIR=/var/sub-wave \
	       SOUNDS_DIR=/sounds \
	       LIQUIDSOAP_HOST=127.0.0.1 \
	       ICECAST_STATUS_URL=http://127.0.0.1:7702/status-json.xsl \
	       ICECAST_ADMIN_URL=http://127.0.0.1:7702/admin/listclients
	node_modules/.bin/tsx src/server.ts
}

# Web — Next.js listener UI (standalone build).
run_web() {
	cd /web || return 1
	export NODE_ENV=production \
	       PORT=7700 \
	       HOSTNAME=0.0.0.0 \
	       CONTROLLER_INTERNAL_URL=http://127.0.0.1:7701 \
	       SUBWAVE_HOMEPAGE="${SUBWAVE_HOMEPAGE:-player}"
	node server.js
}

# Caddy — the single-origin edge that fronts all three on :80.
run_caddy() {
	caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
}

# ---------------------------------------------------------------------------
# supervise <name> <launcher-fn> — restart loop with backoff.
# ---------------------------------------------------------------------------
supervise() {
	local name="$1"; shift
	while true; do
		log "starting $name"
		"$@"
		local code=$?
		log "$name exited ($code) — restarting in 3s"
		sleep 3
	done
}

# ---------------------------------------------------------------------------
# Boot.
#
# Sourcing this file with SUBWAVE_SUPERVISOR_LIB=1 defines the functions
# WITHOUT booting anything — the seam scripts/aio-log-link.test.ts drives to
# exercise link_liquidsoap_log() against a scratch dir. The image never sets
# it, so PID 1 always falls through to the real boot below.
# ---------------------------------------------------------------------------
if [ "${SUBWAVE_SUPERVISOR_LIB:-}" = "1" ]; then
	return 0 2>/dev/null || exit 0
fi

warn_if_state_unmounted
init_state
init_secrets

# On stop, signal the whole process group once, then give the children time to
# shut down before exiting (reset the trap first so the kill doesn't re-enter
# this handler). The grace period matters: this script is PID 1, and the
# instant it exits the container namespace is torn down and everything left
# gets SIGKILLed — which robbed the controller of its SIGTERM handler and left
# library.db's WAL sidecar un-checkpointed on every stop (#786). `wait` covers
# the supervise loops; the sleep covers their children (node etc.), which get
# reparented to us when the loops die and which bash's wait can't see. Docker's
# stop timeout (default 10s) still hard-caps the whole thing.
trap 'trap "" TERM INT; log "shutting down"; kill -TERM 0 2>/dev/null; wait; sleep 2; exit 0' TERM INT

supervise broadcast  run_broadcast  &
supervise controller run_controller &
supervise web        run_web        &
supervise caddy      run_caddy      &

wait
