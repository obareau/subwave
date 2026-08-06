# SUB/WAVE — Liquidsoap broadcast script
# Reads a JSON queue file written by the Node.js controller,
# crossfades, ducks DJ voice over song intros, falls back to autonomous playlist.

settings.log.level := 3
settings.log.file := true
settings.log.file.path := "/var/log/liquidsoap/radio.log"

# Telnet server — used by the controller to send a "restart" command after
# changing settings that this script reads at startup. Bound to all interfaces
# on the container's private network only; NOT exposed to the host.
settings.server.telnet := true
settings.server.telnet.bind_addr := "0.0.0.0"
settings.server.telnet.port := 1234

# Multi-station profiles: the state dir is the ACTIVE station's dir, resolved
# by the container entrypoint (docker/broadcast-entrypoint.sh / the AIO
# supervisor) from state/stations/active.json and exported as
# SUBWAVE_STATE_DIR. Single-station installs and dev runs get the default.
state_dir = environment.get(default="/var/sub-wave", "SUBWAVE_STATE_DIR")

# Scratch dirs for the atomic marker writes below (#1240). Without a temp_dir
# on the state fs, file.write(atomic=true) stages under $TMPDIR (the container
# overlay) and the rename is cross-device — the stdlib silently degrades to a
# NON-atomic copy, the exact half-written-JSON race atomic=true exists to
# prevent. ONE DIR PER WRITER: the stdlib always names its temp file
# `atomic.write` inside the dir it is given, and the jingle write is
# synchronous=false — a shared dir would let concurrent writes interleave.
# Created here (not the entrypoints) so broadcast and the AIO can't drift.
# Probe-checked and null on failure: file.mkdir does NOT raise, and a bad
# temp_dir would ENOENT inside on_metadata — null falls back to $TMPDIR,
# i.e. exactly the old behaviour.
def ensure_tmp_dir(p) =
  file.mkdir(parents=true, p)
  probe = path.concat(p, "probe")
  try
    file.write(data="x", probe)
    file.remove(probe)
    p
  catch err do
    log(
      label="subwave",
      "temp dir #{p} unusable (#{err}); atomic marker writes fall back to $TMPDIR"
    )
    null
  end
end

np_tmp_dir = ensure_tmp_dir("#{state_dir}/tmp/now-playing")
jingle_tmp_dir = ensure_tmp_dir("#{state_dir}/tmp/jingle")
bed_tmp_dir = ensure_tmp_dir("#{state_dir}/tmp/bed")
starve_tmp_dir = ensure_tmp_dir("#{state_dir}/tmp/starve")

# MUSIC STARVE GUARD (#1300 bug 7) — the latch only. Declared up here because
# the jingles gate reads it from a thunk at line ~962, long before the tick
# that drives it can be registered (the tick needs idle_mode, defined ~1214).
# Same lazy-thunk pattern bed_on_air already uses.
music_starved = ref(false)

# ---------------------------------------------------------------------------
# RUNTIME SETTINGS — written by the controller at startup, read here.
# Two tiny text files: one int, one float. Falls back to defaults if missing.
# ---------------------------------------------------------------------------

jingle_ratio = ref(30)
crossfade_duration = ref(10.0)
archive_enabled = ref(false)
archive_bitrate = ref(128)
opus_enabled = ref(false)
opus_bitrate = ref(96)
flac_enabled = ref(false)
aac_enabled = ref(false)
aac_bitrate = ref(192)
stream_bitrate = ref(192)
ogg_icy_metadata = ref(true)
station_name = ref("SUB/WAVE")

# DJ transition effects (sweep / washout / dissolve / chop / exit loop) — see
# dj_transition below. Effects are built PER-BRANCH inside the transition
# callback, on the OUTGOING track's source only: idle playout passes through
# no effect operator, and the incoming track always lands clean and dry. The
# envelopes are pure functions of source.elapsed() on the branch (closures —
# no threads, no shared state), so they hold in AUDIO time under any clock
# (wall-clock thread envelopes drift; exposed by the offline render harness).
# Verified on v2.2.5/v2.4.4/v2.4.5 (scripts/fx-render-test.sh probe). NB:
# v2.4.5 is the MINIMUM runtime — 2.4.4's O(n) clock scan made every effect
# transition peg a core and stall the stream (see Dockerfile.broadcast).
# filter.rc and comb instantiate cleanly INSIDE the cross callback; the
# "Early computation of source content-type" crash is specific to
# iir_filter/HPF.
# WHY comb, NOT echo: native `echo` (incl. ping_pong) is a verified NO-OP on
# BOTH the v2.2.5 and v2.4.4 builds — type-checks, passes audio through
# bit-for-bit (identical md5 dry vs wet; re-confirmed on 2.4.4 with dB-form
# feedback). `comb` is the working PCM primitive with getter feedback; the
# tail is centred, not true L/R ping-pong. Do NOT "simplify" back to `echo`.
# NB: the SVF `filter` operator goes unstable near sr/4 and collapses to
# near-silence — hence filter.rc with the "open" cutoff capped at 9 kHz.

if file.exists("#{state_dir}/liquidsoap_jingle_ratio.txt") then
  raw = string.trim(file.contents("#{state_dir}/liquidsoap_jingle_ratio.txt"))
  v = int_of_string(default=30, raw)
  # 0 is a valid value: jingles OFF (issue #997). Negative/garbage keeps the
  # default.
  if v >= 0 then jingle_ratio := v end
end

if file.exists("#{state_dir}/liquidsoap_crossfade.txt") then
  raw = string.trim(file.contents("#{state_dir}/liquidsoap_crossfade.txt"))
  v = float_of_string(default=10.0, raw)
  if v >= 0.0 then crossfade_duration := v end
end

if file.exists("#{state_dir}/liquidsoap_archive_enabled.txt") then
  raw = string.trim(file.contents("#{state_dir}/liquidsoap_archive_enabled.txt"))
  archive_enabled := (raw == "true")
end

if file.exists("#{state_dir}/liquidsoap_archive_bitrate.txt") then
  raw = string.trim(file.contents("#{state_dir}/liquidsoap_archive_bitrate.txt"))
  v = int_of_string(default=128, raw)
  if v > 0 then archive_bitrate := v end
end

if file.exists("#{state_dir}/liquidsoap_stream_bitrate.txt") then
  raw = string.trim(file.contents("#{state_dir}/liquidsoap_stream_bitrate.txt"))
  v = int_of_string(default=192, raw)
  if v > 0 then stream_bitrate := v end
end

# Opt IN to the Ogg-Opus mount (a continuous encoder + 44.1->48k resample).
# Only Blink clients ever select Opus (web/hooks/usePlayer.ts); the mandatory
# /stream.mp3 mount always serves everyone.
if file.exists("#{state_dir}/liquidsoap_opus_enabled.txt") then
  raw = string.trim(file.contents("#{state_dir}/liquidsoap_opus_enabled.txt"))
  opus_enabled := (raw == "true")
end

if file.exists("#{state_dir}/liquidsoap_opus_bitrate.txt") then
  raw = string.trim(file.contents("#{state_dir}/liquidsoap_opus_bitrate.txt"))
  v = int_of_string(default=96, raw)
  if v > 0 then opus_bitrate := v end
end

# Opt IN to the AAC-LC mount (raw ADTS, audio/aac) — device compatibility for
# players that decode AAC but not Opus. External players only; no resample.
if file.exists("#{state_dir}/liquidsoap_aac_enabled.txt") then
  raw = string.trim(file.contents("#{state_dir}/liquidsoap_aac_enabled.txt"))
  aac_enabled := (raw == "true")
end

if file.exists("#{state_dir}/liquidsoap_aac_bitrate.txt") then
  raw = string.trim(file.contents("#{state_dir}/liquidsoap_aac_bitrate.txt"))
  v = int_of_string(default=192, raw)
  if v > 0 then aac_bitrate := v end
end

# Opt IN to the Ogg-FLAC mount — a lossless capture of the processed bus at
# the source 44.1 kHz (~800-900 kbps encoder, hence off by default; only a
# true lossless tier when the source files are lossless). External players
# only — the web player never auto-selects it.
if file.exists("#{state_dir}/liquidsoap_flac_enabled.txt") then
  raw = string.trim(file.contents("#{state_dir}/liquidsoap_flac_enabled.txt"))
  flac_enabled := (raw == "true")
end

# ICY (out-of-band) per-track titles on BOTH Ogg mounts. ON by default — only
# an explicit "false" disables. See make_stream_outputs() for the client
# trade-off (#1052 vs foobar2000).
if file.exists("#{state_dir}/liquidsoap_ogg_icy_metadata.txt") then
  raw = string.trim(file.contents("#{state_dir}/liquidsoap_ogg_icy_metadata.txt"))
  ogg_icy_metadata := (raw != "false")
end

if file.exists("#{state_dir}/liquidsoap_station_name.txt") then
  raw = string.trim(file.contents("#{state_dir}/liquidsoap_station_name.txt"))
  if raw != "" then station_name := raw end
end

log("settings loaded: jingle_ratio=#{jingle_ratio()} crossfade_duration=#{crossfade_duration()} archive_enabled=#{archive_enabled()} archive_bitrate=#{archive_bitrate()} stream_bitrate=#{stream_bitrate()} opus_enabled=#{opus_enabled()} opus_bitrate=#{opus_bitrate()} flac_enabled=#{flac_enabled()} aac_enabled=#{aac_enabled()} aac_bitrate=#{aac_bitrate()} ogg_icy_metadata=#{ogg_icy_metadata()} station_name=#{station_name()}")

# ---------------------------------------------------------------------------
# subhttp:<full-url> — strips the prefix and shells out to curl. Liquidsoap's
# built-in http.get.stream returns spurious 522s on the Cloudflare-fronted
# Navidrome origin.
# ---------------------------------------------------------------------------
def proto_subhttp(~rlog, ~maxtime, arg) =
  ignore(rlog)
  uri = arg
  raw_timeout = int_of_float(maxtime - time())
  timeout = if raw_timeout < 5 then 5 else raw_timeout end
  ext =
    if string.contains(substring=".mp3", arg) then ".mp3"
    elsif string.contains(substring=".ogg", arg) then ".ogg"
    elsif string.contains(substring=".flac", arg) then ".flac"
    else ".mp3" end
  outfile = file.temp("liq-curl-", ext)
  cmd = "curl -sS -L --max-time #{timeout} -o #{process.quote(outfile)} #{process.quote(uri)}"
  ret = process.run(timeout=float_of_int(timeout), cmd)
  if ret.status == "exit" and ret.status.code == 0 and file.size(outfile) > 0 then
    outfile
  else
    log(label="protocol.subhttp", level=3, "curl failed for #{uri}: status=#{ret.status} code=#{ret.status.code} stderr=#{ret.stderr}")
    file.remove(outfile)
    null
  end
end

protocol.add(temporary=true, syntax="subhttp:<full url>", doc="Navidrome stream via curl", "subhttp", proto_subhttp)

# ---------------------------------------------------------------------------
# QUEUE — the controller writes one annotated track URI to next.txt; polled
# every 1s into request.queue so new tracks land without a restart.
# ---------------------------------------------------------------------------

dj_queue = request.queue(id="dj_queue")

def poll_queue() =
  if file.exists("#{state_dir}/next.txt") then
    contents = string.trim(file.contents("#{state_dir}/next.txt"))
    file.remove("#{state_dir}/next.txt")
    if contents != "" then
      log("Queueing: #{contents}")
      ignore(dj_queue.push(request.create(contents)))
    end
  end
end
thread.run(every=1.0, poll_queue)

# ---------------------------------------------------------------------------
# AUTONOMOUS FALLBACK — the controller maintains auto.m3u with mood-
# appropriate tracks; reload_mode="watch" picks up its rewrites.
# ---------------------------------------------------------------------------

auto_playlist = playlist(
  id="auto",
  reload_mode="watch",
  mode="randomize",
  "#{state_dir}/auto.m3u"
)

# ---------------------------------------------------------------------------
# MAIN MUSIC SOURCE — queue takes priority, falls back to autonomous
# ---------------------------------------------------------------------------

music = fallback(
  id="music",
  track_sensitive=true,
  [dj_queue, auto_playlist]
)

# ---------------------------------------------------------------------------
# HARD TRACK-LENGTH CAP (#447) — the controller stamps liq_cue_out on
# autonomous picks and auto.m3u entries when a max-track-length is set;
# cue_cut stops the track there, so an over-length track NEVER airs in full
# (even ones that slipped selection with unknown duration). Listener requests
# are deliberately UN-stamped — an explicit ask for a long mix isn't cut; a
# cue_out past a shorter track's end is a no-op. Placed BEFORE the music_meta
# capture (one clean on_metadata event per cut track) and before `cross` (the
# cut end drives a normal crossfade out).
# ---------------------------------------------------------------------------
music = cue_cut(music)

# ---------------------------------------------------------------------------
# CROSSFADE TRANSITION — equal-amplitude blend across the full cross window
# ---------------------------------------------------------------------------
# INVARIANT: fade.out/fade.in span the ENTIRE cross() buffer so the tracks
# curve past each other at ~-6 dB midpoint and sum to ~unity. A fade shorter
# than the buffer leaves the outgoing at full level while the incoming ramps
# — +6 dB and an audible doubling/slap-back on every transition (earlier
# per-transition energy scaling did exactly that). For loudness-aware
# behaviour, vary the cross BUFFER length, never the fade inside it.
#
# Low-level `cross`, NOT the `crossfade` wrapper: crossfade(smart=false)
# silently routes through its internal simple_transition and ignores a custom
# callback. `a`/`b` are records with .source/.metadata/.db_level.
#
# Adaptive blends: the controller stamps `liq_cross_duration` per track.
# CRITICAL: `cross` sizes this transition's buffer from the OUTGOING track's
# stamp (registered at its start, controls its END — see liquidsoap docs), so
# the fade must read `a.metadata` too or fade != buffer (a longer fade gets
# truncated → audible gap; a shorter one sums to +6 dB). Absent/unparseable →
# crossfade_duration(). Effect operators are instantiated inside the callback
# — proven safe for filter.rc/comb specifically; re-run
# scripts/fx-render-test.sh before adding any OTHER operator class here.
def dj_transition(a, b) =
  d = float_of_string(default=crossfade_duration(), a.metadata["liq_cross_duration"])
  # Washout rides the ENDING track's own annotation — `a` IS the flagged track,
  # so there is no arming, no remaining() watcher, and no race against a
  # listener request jumping the queue. The controller stamps liq_washout_delay
  # (tempo-synced, dotted-eighth of the track's BPM) alongside the flag.
  washing = a.metadata["liq_washout"] == "true"
  # Exit loop rides the ENDING track's own annotation, exactly like the
  # washout — `a` IS the flagged track, its canvas and bar length were
  # stamped on it when it was queued. Washout wins when both ride one track
  # (it may carry the length-cap auto-arm; the queue avoids stacking them,
  # this is belt-and-braces).
  looping = a.metadata["liq_loop"] == "true" and not washing
  # Sweep rides the INCOMING pick's annotation but the filter is applied to
  # the OUTGOING branch: the leaving track sinks under a closing lowpass.
  # All three entry-side effects (sweep/dissolve/chop) yield to a loop riding
  # the outgoing exit — the loop IS the transition, and garnishing it chokes
  # the gesture. The queue strips these upstream; enforced here too.
  sweeping = b.metadata["liq_sweep"] == "true" and not looping
  # Dissolve (reverb wash) rides the INCOMING pick, applied to the OUTGOING
  # branch: the leaving track dissolves into a diffuse comb-cluster wash. The
  # SMOOTH clash option (sweep = dramatic); armed only between CLASHING
  # tracks (mix.effectAllowedFor). The washout wins when both ride — it may
  # carry the length-cap auto-arm.
  dissolving = b.metadata["liq_dissolve"] == "true" and not washing and not looping
  # Chop (crossfader cut) rides the INCOMING pick, applied to the OUTGOING
  # branch: rhythmic gating at full level. The PERCUSSIVE clash option; armed
  # only between CLASHING tracks (mix.effectAllowedFor), with liq_chop_period
  # stamped as one beat of the OUTGOING track's BPM. Same washout precedence
  # as the dissolve.
  chopping = b.metadata["liq_chop"] == "true" and not washing and not looping
  # Washout drops the dry signal early (exp fade) so the tail reads as a
  # dissolve. An early drop sums BELOW unity mid-cross — a dip, which is the
  # effect; the +6 dB doubling hazard is only for fades that hold full level
  # early (see the fade == buffer invariant above).
  a_source =
    if washing then
      fade.out(duration=d, type="exp", initial_metadata=a.metadata, a.source)
    elsif sweeping then
      # A real filter-kill: the FILTER does the removal, not the fader. A log
      # fade holds the outgoing's level up longer so the closing filter is
      # heard choking a still-loud track — with the default fade the track was
      # already quiet by the time the cutoff got dramatic and the sweep felt
      # powerless (found on-air).
      fade.out(duration=d, type="log", initial_metadata=a.metadata, a.source)
    elsif chopping then
      # Same reasoning as the sweep: the GATE does the removal, not the fader.
      # A log fade keeps the stabs hot deep into the window — a DJ cutting the
      # crossfader cuts at full level; the gate envelope (duty shrink + beat
      # sparsening + master exit) is what takes the track out.
      fade.out(duration=d, type="log", initial_metadata=a.metadata, a.source)
    elsif looping then
      # The dry only plays through the capture pass (one bar) before the hard
      # gate cuts it — a log fade keeps that bar essentially at full level, so
      # the loop is seeded hot (a linear fade would seed it a couple of dB
      # down and every repeat inherits the loss).
      fade.out(duration=d, type="log", initial_metadata=a.metadata, a.source)
    else
      fade.out(duration=d, initial_metadata=a.metadata, a.source)
    end
  # SWEEP ENVELOPE — how a DJ rides the filter out of a track: a slow
  # smoothstep close over the first 70% of the blend, held at the floor while
  # the fade finishes. The cutoff moves in LOG-frequency space (pow) — linear
  # Hz ramps sound like nothing-then-everything; log space is how a filter
  # knob feels. No release phase: the outgoing branch ends with the cross, so
  # there is nothing to reopen. Pure function of the branch's own
  # source.elapsed(), evaluated per frame by the getter — audio-time-accurate
  # under any clock, no threads, no shared state.
  a_source =
    if sweeping then
      log("DJ sweep: closing the filter over the outgoing track (d=#{d}s)")
      sweep_src = a_source
      # Close FAST and DEEP — over the first 45% of the blend down to 600 Hz,
      # through three RC stages (18 dB/oct), so the choke arrives while the
      # outgoing is still loud (the log fade above holds its level up). A
      # slower/shallower close spread over 70% was inaudible under the fade.
      def sweep_cut() =
        e = source.elapsed(sweep_src)
        e = if e < 0. then 0. else e end
        t_close = 0.45 * d
        t_hold  = 0.55 * d
        t_back  = 0.85 * d
        # Dive to the floor, touch it briefly, then PARTIALLY re-open as the
        # incoming takes over: a sustained floor reads as "the track went
        # quiet"; a brief bottom with the outgoing re-emerging under the new
        # track reads as the gesture (second on-air 'goes quiet' report).
        depth =
          if e < t_close then
            x = e / t_close
            3.0 * x * x - 2.0 * x * x * x
          elsif e < t_hold then
            1.0
          elsif e < t_back then
            x = (e - t_hold) / (t_back - t_hold)
            1.0 - 0.6 * (3.0 * x * x - 2.0 * x * x * x)
          else
            0.4
          end
        9000.0 * pow(1100.0 / 9000.0, depth)       # 9 kHz open → 600 Hz floor
      end
      # Wet ramps 0→1 over the first ~15% of the blend: an RC at 9 kHz is NOT
      # transparent (−dB at the cutoff + roll-off), so engaging it full-wet at
      # the cross start lands as an instant dulling — the filter must fade IN,
      # then the closing cutoff does the work (found on-air).
      # Makeup on the choked branch: the filter guts the outgoing's energy
      # right when the incoming is only half-faded, and the mid-blend went
      # near-quiet (twice, by ear). Lift the choked residual +2.6 dB as the
      # cutoff bottoms out so the blend keeps its body — the choke stays
      # dramatic spectrally without a level hole.
      def sweep_gain() =
        e = source.elapsed(sweep_src)
        e = if e < 0. then 0. else e end
        g_max = 1.35
        t_from = 0.30 * d
        t_to   = 0.50 * d
        if e <= t_from then 1.0
        elsif e >= t_to then g_max
        else
          x = (e - t_from) / (t_to - t_from)
          1.0 + (3.0 * x * x - 2.0 * x * x * x) * (g_max - 1.0)
        end
      end
      # PARALLEL DRY BLEED — the "never goes quiet" guarantee. Wetness on
      # cascaded stages multiplies the dry path (0.35 × 0.35 ≈ 12% ≈ −18 dB),
      # which is why every wetness-cap attempt still cratered the mid-band.
      # An explicit dry branch around a full-wet chain gives a HARD floor:
      # 30% of the untouched track always reaches the mix (≈ −10 dB, ≈ −8 dB
      # after makeup), no matter how deep the cutoff dives.
      swept = filter.rc(frequency=sweep_cut, mode="low", wetness=1.,
                filter.rc(frequency=sweep_cut, mode="low", wetness=1., a_source))
      amplify(sweep_gain, add(normalize=false,
        [amplify(0.30, a_source), amplify(0.75, swept)]))
    else
      a_source
    end
  # WASHOUT ENVELOPE — dub-style tail: the comb feedback swells over the first
  # quarter of the blend while the exp fade above drops the dry signal away
  # early, so the delay line SELF-SUSTAINS: the track dissolves into a pulsing,
  # decaying tail over the incoming track's opening instead of echo layered on
  # a still-full-level song. Feedback releases to silent by 0.95*d — the
  # transition source is truncated at d, so the tail must decay before the
  # window closes or it clicks off. Same closure pattern as the sweep.
  # BLEND (spectral handover) — the continuity move, the sweep's mirror: the
  # OUTGOING track hands its bass (by ~25%), then its mids (by ~65%), to the
  # incoming, keeping only its highs to the end; the incoming arrives
  # lows-first underneath (see the b-side block below). At every moment the
  # sum reads as ONE full-spectrum piece of music whose ingredients are
  # swapping — the club "EQ mixing" technique for seamless long blends. The
  # controller only arms it between COMPATIBLE tracks (mix.effectAllowedFor).
  # At e=0 the HPF sits at 30 Hz ≈ transparent, so the engage is seamless.
  blending = b.metadata["liq_blend"] == "true" and not looping
  a_source =
    if blending then
      log("DJ blend: spectral handover into the next track (d=#{d}s)")
      ha_src = a_source
      def blend_hp() =
        e = source.elapsed(ha_src)
        e = if e < 0. then 0. else e end
        t_end = 0.65 * d
        x = if e >= t_end then 1.0 else e / t_end end
        sxx = 3.0 * x * x - 2.0 * x * x * x
        30.0 * pow(1800.0 / 30.0, sxx)            # 30 Hz → 1.8 kHz (log space)
      end
      # SUBTRACT-HPF: filter.rc mode="high" is BROKEN in the v2.2.5 build —
      # even a static 400 Hz high-pass collapses music to −115 dB (verified by
      # render; same defect family as the `echo` no-op) — and STILL broken on
      # v2.4.4 (re-verified: 40 Hz HPF on a 440 Hz tone renders −inf silence).
      # High-pass is built
      # from proven parts instead: dry − lowpass(dry). Polarity inversion and
      # twin-consumer frame alignment verified: src + amplify(-1., src)
      # renders exact silence.
      blend_low = filter.rc(frequency=blend_hp, mode="low", wetness=1., a_source)
      add(normalize=false, [a_source, amplify(-1., blend_low)])
    else
      a_source
    end
  a_source =
    if washing then
      wd = float_of_string(default=0.30, a.metadata["liq_washout_delay"])
      log("DJ washout: dissolving the outgoing track, tap=#{wd}s (d=#{d}s)")
      wash_src = a_source
      # The swell must beat the exp fade: feedback peaks within ~10% of the
      # blend, while the outgoing material is still hot, so the delay line
      # loads audible audio — swelling at 25% seeded the tail from an
      # already-faded signal and the wash was inaudible (found on-air). The
      # higher fb (−1.5 dB ≈ ×0.84/tap) sustains the tail across the blend;
      # buildup is bounded because the exp fade starves the input within a
      # couple of seconds, and the brick-wall limiter backs the bus anyway.
      def wash_fb() =
        e = source.elapsed(wash_src)
        e = if e < 0. then 0. else e end
        fb_max = -1.0            # peak feedback dB (nearer 0 = longer tail; <unity)
        fb_off = -90.0           # idle/silent
        t_swell = 0.10 * d
        t_hold  = 0.85 * d
        t_rel   = 0.97 * d
        if e < t_swell then
          x = e / t_swell
          s = 3.0 * x * x - 2.0 * x * x * x       # smoothstep swell
          fb_off + s * (fb_max - fb_off)
        elsif e < t_hold then
          fb_max
        elsif e < t_rel then
          fb_max + ((e - t_hold) / (t_rel - t_hold)) * (fb_off - fb_max)
        else
          fb_off
        end
      end
      # Late makeup gain (+3.5 dB) so the tail sits PRESENT over the incoming
      # track's fade-in instead of buried under it. It comes up only after the
      # exp fade has dropped the dry (0.3·d → 0.55·d), so it never bumps the
      # still-audible song — it lifts the echoes alone (found on-air: the
      # dissolve was correct but too quiet to register).
      def wash_gain() =
        e = source.elapsed(wash_src)
        e = if e < 0. then 0. else e end
        g_max = 1.95             # ≈ +5.8 dB — the tail must sit OVER a dense incoming mix
        t_from = 0.30 * d
        t_to   = 0.55 * d
        if e <= t_from then 1.0
        elsif e >= t_to then g_max
        else
          x = (e - t_from) / (t_to - t_from)
          1.0 + (3.0 * x * x - 2.0 * x * x * x) * (g_max - 1.0)
        end
      end
      # Darkening tail — a real dub/DJ delay feeds back through a filter, so
      # every repeat comes back darker. The comb's loop is fixed, so instead a
      # lowpass AFTER it closes across the window (9 kHz → 1.5 kHz, log space):
      # later repeats occur later in time, so they arrive darker — the tail
      # recedes into the dark instead of ringing at full brightness. Wet ramps
      # in over the first 20% (an RC at 9 kHz is not transparent — engaging it
      # full-wet would dull the still-audible dry, same lesson as the sweep).
      def tail_cut() =
        e = source.elapsed(wash_src)
        e = if e < 0. then 0. else e end
        t_from = 0.35 * d
        t_to   = 0.90 * d
        x = if e <= t_from then 0.0 elsif e >= t_to then 1.0 else (e - t_from) / (t_to - t_from) end
        s = 3.0 * x * x - 2.0 * x * x * x
        9000.0 * pow(3000.0 / 9000.0, s)
      end
      def tail_wet() =
        e = source.elapsed(wash_src)
        e = if e < 0. then 0. else e end
        t_on = 0.20 * d
        x = if e >= t_on then 1.0 else e / t_on end
        3.0 * x * x - 2.0 * x * x * x
      end
      washed = comb(delay=wd, feedback=wash_fb, a_source)
      washed = filter.rc(frequency=tail_cut, mode="low", wetness=tail_wet,
                 filter.rc(frequency=tail_cut, mode="low", wetness=tail_wet, washed))
      amplify(wash_gain, washed)
    else
      a_source
    end
  # DISSOLVE ENVELOPE — the reverb wash. Same topology as the washout (comb →
  # cascaded damped lowpass → late makeup) with two deliberate differences:
  #   1. FOUR parallel combs at mutually prime, tempo-UNRELATED delays
  #      (43/61/79/101 ms) instead of one tempo-synced tap — the tails smear
  #      into diffuse ambience instead of a rhythmic pulse. No allpass exists
  #      in the proven kit (native echo is a no-op on both engine builds), so
  #      diffusion comes from the prime spread plus heavy damping; the wash
  #      also sits UNDER the rising pick, which hides the metallic edge a
  #      Schroeder cluster has when exposed.
  #   2. The damping lowpass closes deeper (7 kHz → 1.2 kHz) — the wash reads
  #      as the track receding into a large dark space, not echoing in place.
  # Feedback swells fast (within 15% of d, while the exp-faded dry is still
  # hot enough to seed the cluster — the washout's on-air lesson), holds, and
  # releases to silence by 0.93·d so the tail is dead before the transition
  # source truncates at d. Each comb's tail is isolated from its dry
  # pass-through (see pure_tail below) so the wash can run hot without
  # multiplying the dry path.
  a_source =
    if dissolving then
      log("DJ dissolve: reverb wash under the next track (d=#{d}s)")
      diss_src = a_source
      def diss_fb() =
        e = source.elapsed(diss_src)
        e = if e < 0. then 0. else e end
        # Per-tap dB. Tail decay = fb/delay per SECOND, so short taps need
        # near-unity feedback: -0.5 dB on 89–181 ms taps ≈ a 3–6 dB/s,
        # multi-second wash. The first cut (-2.5 dB on 43–101 ms taps)
        # decayed 25–58 dB/s — rendered indistinguishable from dry.
        fb_max = -0.5
        fb_off = -90.0
        # The swell must beat the exp fade (the washout's on-air lesson): the
        # loop only ever holds what it was fed while the dry was still hot.
        t_swell = 0.10 * d
        t_hold  = 0.80 * d
        t_rel   = 0.93 * d
        if e < t_swell then
          x = e / t_swell
          s = 3.0 * x * x - 2.0 * x * x * x
          fb_off + s * (fb_max - fb_off)
        elsif e < t_hold then
          fb_max
        elsif e < t_rel then
          fb_max + ((e - t_hold) / (t_rel - t_hold)) * (fb_off - fb_max)
        else
          fb_off
        end
      end
      # Late makeup, same rationale as the washout: lift the wash alone after
      # the exp fade has dropped the dry, so the ambience sits present over
      # the incoming track instead of buried. Hotter than the washout's 1.95
      # in linear terms is NOT what this is — the wash's four 0.25-weighted
      # taps start ~12 dB below the washout's single unity tap, so 2.2 here
      # still lands the bed several dB under where the washout tail sits.
      def diss_gain() =
        e = source.elapsed(diss_src)
        e = if e < 0. then 0. else e end
        g_max = 1.3
        t_from = 0.25 * d
        t_to   = 0.50 * d
        if e <= t_from then 1.0
        elsif e >= t_to then g_max
        else
          x = (e - t_from) / (t_to - t_from)
          1.0 + (3.0 * x * x - 2.0 * x * x * x) * (g_max - 1.0)
        end
      end
      # Darkening: later reflections arrive later in time, so a lowpass
      # closing across the window makes the wash recede into the dark. Wet
      # ramps in over the first 10% (an RC at 7 kHz is not transparent —
      # engaging it full-wet at cross start dulls the still-audible dry;
      # the sweep's on-air lesson).
      def diss_cut() =
        e = source.elapsed(diss_src)
        e = if e < 0. then 0. else e end
        t_from = 0.30 * d
        t_to   = 0.90 * d
        x = if e <= t_from then 0.0 elsif e >= t_to then 1.0 else (e - t_from) / (t_to - t_from) end
        s = 3.0 * x * x - 2.0 * x * x * x
        7000.0 * pow(1200.0 / 7000.0, s)
      end
      def diss_wet() =
        e = source.elapsed(diss_src)
        e = if e < 0. then 0. else e end
        t_on = 0.10 * d
        x = if e >= t_on then 1.0 else e / t_on end
        3.0 * x * x - 2.0 * x * x * x
      end
      # PURE-TAIL isolation: comb passes its input, so summing four combs
      # directly forces a 0.25 weight to keep the dry at unity — which buries
      # the tails 12 dB down before they even start (first render: a −44 dB
      # mid-cross crater, wash inaudible). Subtracting the input from each
      # comb leaves ONLY the feedback tail (src + amplify(-1., src) nulls
      # exactly — the twin-consumer alignment the blend already relies on),
      # so the dry rides the faded path once and the tails run hot.
      def pure_tail(tap) =
        add(normalize=false,
          [comb(delay=tap, feedback=diss_fb, a_source), amplify(-1., a_source)])
      end
      washed = add(normalize=false,
        [amplify(0.7, pure_tail(0.089)), amplify(0.7, pure_tail(0.113)),
         amplify(0.7, pure_tail(0.151)), amplify(0.7, pure_tail(0.181))])
      washed = filter.rc(frequency=diss_cut, mode="low", wetness=diss_wet,
                 filter.rc(frequency=diss_cut, mode="low", wetness=diss_wet, washed))
      # Dry (faded) + wash: the track walks out through its own ambience.
      add(normalize=false, [a_source, amplify(diss_gain, washed)])
    else
      a_source
    end
  # CHOP ENVELOPE — the crossfader cut: rhythmic gating of the outgoing
  # track, opening AT each beat start so the downbeat transient survives.
  # Pure `amplify` over source.elapsed() — the proven closure pattern, no new
  # operator class (no fx-render-test re-probe needed). Runs on its own
  # compressed clock dd = min(d, 10 s): stretched over a long crossfade the
  # cut read as slow pumping (heard on-air, #861). Per frame: the gate RATE
  # accelerates like a transform cut (quarters → eighths at 40% → sixteenth
  # stutter at 72%; p/2 and p/4 divide p, so every beat start stays a
  # gate-open); DUTY tightens 1.0 → 0.55 → 0.30; the FLOOR under the closed
  # gate drops 0.45 → 0 over the first 25% (the first holes read as
  # beat-synced pumping, then harden — full silence between the very first
  # stabs read as dropouts). The stutter accelerando IS the exit — isolated
  # late stabs read as slowing down, the wrong direction for a cut. Gate
  # edges are ~12 ms smoothsteps (square edges click); a wet ramp over the
  # first 8% keeps the engage bit-transparent (gain exactly 1 at e=0); a
  # master release silences the branch by 0.92·dd, well before the transition
  # source truncates at d.
  a_source =
    if chopping then
      p = float_of_string(default=0.5, b.metadata["liq_chop_period"])
      p = if p <= 0.05 then 0.5 else p end
      dd = if d > 10. then 10. else d end
      log("DJ chop: cutting the outgoing track on the beat (p=#{p}s, dd=#{dd}s, d=#{d}s)")
      chop_src = a_source
      def chop_gain() =
        e = source.elapsed(chop_src)
        e = if e < 0. then 0. else e end
        # Accelerating clock: quarters → eighths → sixteenth stutter.
        pp =
          if e < 0.40 * dd then p
          elsif e < 0.72 * dd then 0.5 * p
          else 0.25 * p
          end
        beat = int_of_float(e / pp)
        ph = e / pp - float_of_int(beat)         # 0..1 within the gate
        t1 = 0.15 * dd
        t2 = 0.72 * dd
        duty =
          if e < t1 then
            x = e / t1
            1.0 - (3.0 * x * x - 2.0 * x * x * x) * 0.45
          elsif e < t2 then
            x = (e - t1) / (t2 - t1)
            0.55 - (3.0 * x * x - 2.0 * x * x * x) * 0.25
          else
            0.30
          end
        f_end = 0.25 * dd
        floor_g =
          if e >= f_end then 0.0
          else
            x = e / f_end
            0.45 * (1.0 - (3.0 * x * x - 2.0 * x * x * x))
          end
        eps = 0.012 / pp                         # ~12 ms edges, in phase units
        shape =
          if ph < eps then
            x = ph / eps
            3.0 * x * x - 2.0 * x * x * x
          elsif ph < duty then 1.0
          elsif ph < duty + eps then
            x = (ph - duty) / eps
            1.0 - (3.0 * x * x - 2.0 * x * x * x)
          else 0.0
          end
        g_gate = floor_g + (1.0 - floor_g) * shape
        # Engage ramp: gain 1.0 at e=0, gate fully in by 8% of the gesture.
        t_eng = 0.08 * dd
        wet =
          if e >= t_eng then 1.0
          else
            x = e / t_eng
            3.0 * x * x - 2.0 * x * x * x
          end
        g = 1.0 - wet * (1.0 - g_gate)
        # Master release: silent from 0.92·dd — the throw. The rest of the
        # buffer belongs to the incoming ramp.
        master =
          if e < 0.82 * dd then 1.0
          elsif e < 0.92 * dd then
            x = (e - 0.82 * dd) / (0.10 * dd)
            1.0 - (3.0 * x * x - 2.0 * x * x * x)
          else 0.0
          end
        g * master
      end
      amplify(chop_gain, a_source)
    else
      a_source
    end
  # LOOP ENVELOPE — exit loop: the last bar of the OUTGOING track is caught
  # in a loop as the dry is hard-cut, rides in tempo under the pick, then
  # filters down and releases.
  #
  # Measured comb facts (burst-probed on the real v2.4.5 image, PR #863):
  # this build's `comb` is a ONE-SHOT feed-forward echo, NOT recirculating —
  # one burst in yields exactly one delayed copy whatever the feedback value,
  # so no single comb can loop. Hence a CASCADE OF DOUBLING DELAYS: K combs
  # at bar/2·bar/4·bar/8·bar convolve to taps at every multiple 0..(2^K−1) of
  # bar, so a one-bar capture tiles gaplessly (no overlap, no pileup) and
  # terminates by construction. At feedback=0.0 the tap set measures FLAT at
  # a fixed −6 dB regardless of stage count — one constant ×2 makeup restores
  # unity. The 4·bar/8·bar stages are built only when their delay < d (a tap
  # at ≥ d is never heard; 2^K·bar ≥ d guarantees repeats fill the canvas).
  #
  # Unity through the CAPTURE PASS (first bar), then a hard 12 ms cut — the
  # CUT is what reads as "caught in a loop". Known compromise: the analyzer
  # gives tempo, not beat PHASE, so this lands as a tape-loop, not a gridded
  # serato loop; the splice tick repeats in tempo (reads as vinyl) and the
  # ride-out lowpass softens it.
  a_source =
    if looping then
      bar = float_of_string(default=2.0, a.metadata["liq_loop_bar"])
      bar = if bar <= 0.2 then 2.0 else bar end
      log("DJ loop: catching the last bar of the outgoing track (bar=#{bar}s, d=#{d}s)")
      loop_src = a_source
      # Dry gate: unity through the capture pass, then the hard cut.
      # Everything heard after is the cascade re-emitting that one bar.
      def loop_dry() =
        e = source.elapsed(loop_src)
        e = if e < 0. then 0. else e end
        edge = 0.012
        if e < bar - edge then 1.0
        elsif e < bar then
          x = (e - (bar - edge)) / edge
          1.0 - (3.0 * x * x - 2.0 * x * x * x)
        else 0.0 end
      end
      # Ride-out darkening — a DJ filters the loop down as the new track takes
      # over: the cutoff closes 9 kHz → 2.5 kHz (log space) over the back half.
      # Wet stays 0 through the capture pass (an RC at 9 kHz is not
      # transparent — the sweep's on-air lesson; the still-audible dry passes
      # through this chain too) and ramps in only after the cut.
      def loop_cut() =
        e = source.elapsed(loop_src)
        e = if e < 0. then 0. else e end
        t_from = 0.45 * d
        t_to   = 0.90 * d
        x = if e <= t_from then 0.0 elsif e >= t_to then 1.0 else (e - t_from) / (t_to - t_from) end
        s = 3.0 * x * x - 2.0 * x * x * x
        9000.0 * pow(2500.0 / 9000.0, s)
      end
      def loop_wet() =
        e = source.elapsed(loop_src)
        e = if e < 0. then 0. else e end
        t_on = bar + 0.15 * d
        x = if e >= t_on then 1.0 elsif e <= bar then 0.0 else (e - bar) / (0.15 * d) end
        3.0 * x * x - 2.0 * x * x * x
      end
      # Master release — the ONLY level release (a feed-forward cascade has
      # no feedback to ramp down): the loop rides flat, then fades out under
      # the incoming from 0.80·d, silent from 0.92·d — before the branch
      # truncates at d.
      def loop_master() =
        e = source.elapsed(loop_src)
        e = if e < 0. then 0. else e end
        if e < 0.80 * d then 1.0
        elsif e < 0.92 * d then
          x = (e - 0.80 * d) / (0.12 * d)
          1.0 - (3.0 * x * x - 2.0 * x * x * x)
        else 0.0 end
      end
      gated  = amplify(loop_dry, a_source)
      looped = comb(delay=bar, feedback=0.0, gated)
      looped = comb(delay=2.0 * bar, feedback=0.0, looped)
      looped = if 4.0 * bar < d then comb(delay=4.0 * bar, feedback=0.0, looped) else looped end
      looped = if 8.0 * bar < d then comb(delay=8.0 * bar, feedback=0.0, looped) else looped end
      # The cascade measures a fixed −6 dB whatever the stage count (see the
      # header comment) — one constant makeup restores the loop to unity.
      looped = amplify(2.0, looped)
      looped = filter.rc(frequency=loop_cut, mode="low", wetness=loop_wet,
                 filter.rc(frequency=loop_cut, mode="low", wetness=loop_wet, looped))
      amplify(loop_master, looped)
    else
      a_source
    end
  b_source = fade.in(duration=d, initial_metadata=b.metadata, b.source)
  # INCOMING side of a sweep — two real-DJ moves, both fully transparent well
  # before the outgoing track is gone (release = wetness → 0, because an RC
  # filter at its "open" cutoff still is not transparent):
  #   1. SURFACING — the pick materialises from far away: a lowpass opens
  #      500 Hz → 9 kHz over the first 35% of the blend and is fully OUT by
  #      40%, while the old track still dominates. (The v1 mistake was a
  #      muffle that outlived the transition; opening fast and early keeps
  #      the "approaching" feel without the broken-sounding landing.)
  #   2. BASS SWAP — a highpass holds the pick's low end back so two
  #      basslines never fight across the long blend, then releases at
  #      ~45–62% and the bass lands like a small drop — the most
  #      professional-sounding instant of the whole move. (Releases sit
  #      earlier than a club bass-swap so the incoming fills the middle of
  #      the blend — with both tracks processed, ~50% went near-silent.)
  # Net arc: mid-band → highs bloom (35%) → bass drops (65%) → standalone.
  # BLEND, incoming side: the pick arrives lows-first — a lowpass opens
  # 250 Hz → 9 kHz over the first 70% (log space) as the outgoing HPF climbs,
  # so the two trade the spectrum in complementary bands. Wetness releases to
  # 0 by 82% (release must be wet→0: an RC at its open cutoff is never fully
  # transparent, and the branch operators vanish at the d boundary — the
  # track must already be bit-clean before then).
  b_source =
    if blending then
      bin_src = b_source
      def blend_lp() =
        e = source.elapsed(bin_src)
        e = if e < 0. then 0. else e end
        t_open = 0.70 * d
        x = if e >= t_open then 1.0 else e / t_open end
        sxx = 3.0 * x * x - 2.0 * x * x * x
        250.0 * pow(9000.0 / 250.0, sxx)
      end
      def blend_lp_wet() =
        e = source.elapsed(bin_src)
        e = if e < 0. then 0. else e end
        t_from = 0.70 * d
        t_to   = 0.82 * d
        x = if e <= t_from then 0.0 elsif e >= t_to then 1.0 else (e - t_from) / (t_to - t_from) end
        1.0 - (3.0 * x * x - 2.0 * x * x * x)
      end
      filter.rc(frequency=blend_lp, mode="low", wetness=blend_lp_wet,
        filter.rc(frequency=blend_lp, mode="low", wetness=blend_lp_wet, bin_src))
    else
      b_source
    end
  b_source =
    if sweeping then
      in_src = b_source
      def surf_cut() =
        e = source.elapsed(in_src)
        e = if e < 0. then 0. else e end
        t_open = 0.30 * d
        x = if e >= t_open then 1.0 else e / t_open end
        s = 3.0 * x * x - 2.0 * x * x * x
        500.0 * pow(9000.0 / 500.0, s)            # 500 Hz → open, log space
      end
      def surf_wet() =
        e = source.elapsed(in_src)
        e = if e < 0. then 0. else e end
        t_from = 0.20 * d
        t_to   = 0.32 * d
        x = if e <= t_from then 0.0 elsif e >= t_to then 1.0 else (e - t_from) / (t_to - t_from) end
        1.0 - (3.0 * x * x - 2.0 * x * x * x)     # wet 1 → 0 (fully dry by 40%)
      end
      # Bass swap via SUBTRACT-HPF (mode="high" is broken — see the blend
      # block above; it was silencing the whole incoming track while its
      # wetness was up, the real culprit behind the mid-blend dropouts):
      # subtract `bass_amt` of the track's own <160 Hz content, releasing
      # amt 1 → 0 over 38–55% so the bass lands as the outgoing bows out.
      def bass_amt() =
        e = source.elapsed(in_src)
        e = if e < 0. then 0. else e end
        t_from = 0.38 * d
        t_to   = 0.55 * d
        x = if e <= t_from then 0.0 elsif e >= t_to then 1.0 else (e - t_from) / (t_to - t_from) end
        0.0 - (1.0 - (3.0 * x * x - 2.0 * x * x * x))
      end
      bs = filter.rc(frequency=surf_cut, mode="low", wetness=surf_wet,
             filter.rc(frequency=surf_cut, mode="low", wetness=surf_wet, in_src))
      bs_low = filter.rc(frequency=160., mode="low", wetness=1., bs)
      add(normalize=false, [bs, amplify(bass_amt, bs_low)])
    else
      b_source
    end
  add(normalize=false, [a_source, b_source])
end

# Keep a handle on the PRE-cross music source so the on_metadata hook
# (attached further down, where on_meta is defined) sees clean per-track
# metadata events. Hooking the post-cross source fires twice per
# transition — the custom dj_transition below builds fade.in/fade.out
# with initial_metadata=, and the outgoing track wins, stranding the UI
# one song behind until the next crossfade.
music_meta = music

# BEDS ↔ JINGLES — true from a bed's first metadata until the next real
# song's (both set in on_meta below). The jingle rotate counts every
# music-chain track and a bed IS a track, so without this gate a stinger can
# land BETWEEN the bed and the song it ramps into. While up, the jingles
# source reads as unavailable and the rotate defers to the next real boundary.
bed_on_air = ref(false)

# JINGLES & STATION ID — rotate a jingle in every N tracks.
#
# CRITICAL: this rotate MUST sit here, on the raw pre-cross / pre-duck music
# source. `rotate` is track_sensitive and only advances at a track boundary
# of the source it is playing — `cross` and the `smooth_add` layers present
# their output as ONE never-ending track, so a rotate above them plays one
# jingle at startup and is then stuck on music forever ("jingles only fire
# once per restart"). An empty jingles.m3u is fine (rotate skips the
# unavailable source). music_meta is captured ABOVE this, so jingles never
# show up in now-playing.
# jingle_ratio 0 = jingles OFF (#997): the rotate isn't built at all. Applied
# at startup like every liquidsoap_*.txt setting — changes need a mixer
# restart.
music =
  if jingle_ratio() > 0 then
    jingles = playlist(
      id="jingles",
      mode="randomize",
      reload_mode="watch",
      "#{state_dir}/jingles.m3u"
    )
    # Announce each jingle to the controller. Jingles are invisible to it (no
    # on_metadata — music_meta is captured above this rotate) and play outside
    # its airVoice voice serialiser, so a TTS segment aired at the incoming
    # track's boundary could talk over the stinger (issue #997). This marker is
    # written at FEED time — the jingle turns audible ~crossfade_duration later
    # (the cross buffer) — and the controller holds its voice chain until the
    # marker's window (start + crossfade + clip length) has passed.
    jingles.on_metadata(synchronous=false, fun (m) ->
      file.write(
        data=json.stringify(compact=true, {
          filename = m["filename"],
          startedAt = time()
        }),
        atomic=true,
        temp_dir=jingle_tmp_dir,
        "#{state_dir}/jingle-playing.json"
      )
    )
    # A bed on air makes jingles unavailable (see bed_on_air above) so the
    # rotate can't split a bed from the song it ramps into.
    jingles = source.available(jingles, {not bed_on_air() and not music_starved()})
    rotate(
      weights=[1, jingle_ratio()],  # 1 jingle for every N music tracks (settings.json)
      [jingles, music]
    )
  else
    music
  end

# Per-track loudness normalisation: the controller stamps `liq_amplify`
# ("<n> dB" form) on any track with a measured LUFS; `amplify` reads it per
# track — the ReplayGain mechanism. Base 1.0 = unity for un-analysed tracks.
# BEFORE the cross (each track carries its own gain into the crossfade),
# AFTER the music_meta capture. The bus itself stays limiter-only.
music = amplify(override="liq_amplify", 1., music)

# persist_override=true (2.4): with the new default (false) the
# liq_cross_duration override is reset before it ever sizes the stamped
# track's own end-of-track buffer (verified by scripts/fx-render-test.sh
# xdur: stamped 12 rendered an 86s output — static buffer — without persist,
# 78s — stamp honoured — with it). Persist restores the 2.2.5 sizing. The
# flip side of persist is that a stamp would linger over later unstamped
# tracks, so the controller now stamps EVERY track it annotates
# (subsonic.getAnnotatedUri falls back to the operator's crossfade setting),
# making the lingering value always the intended one.
music = cross(
  duration=crossfade_duration(),
  persist_override=true,
  dj_transition,
  music
)

# ---------------------------------------------------------------------------
# DJ VOICE — TTS clips dropped as paths into say.txt / intro.txt.
# voice_queue = solo voice (heavy duck: station IDs, hourly, request
# back-announce); intro_queue = talk-over links (light duck, the song stays
# audible underneath).
# ---------------------------------------------------------------------------
voice_queue = request.queue(id="voice_queue")
intro_queue = request.queue(id="intro_queue")

# Sound-effects channel — short pre-rendered stingers the DJ agent plays
# UNDER its voice. The controller writes a clip path into /var/sub-wave/sfx.txt
# (see broadcast/sfx.js + queue.playSfx). Not mic-chained — the audio is
# already produced — and mixed in below (its own light `smooth_add` layer).
sfx_queue = request.queue(id="sfx_queue")

# Silent lead-in clip, pushed immediately before each speech file: smooth_add
# ducks over the silence so the dip completes BEFORE the DJ's first word.
# request.queue plays the two pushes gaplessly, so the duck holds across the
# join. The speech file may be WAV (Piper/Kokoro) or mp3 (ElevenLabs).
leadin_path = "/sounds/leadin.wav"
has_leadin = file.exists(leadin_path)
if has_leadin then
  log("Voice lead-in enabled: #{leadin_path}")
else
  log("No #{leadin_path} — DJ voice will duck without a pre-roll lead-in")
end

def poll_voice() =
  if file.exists("#{state_dir}/say.txt") then
    contents = string.trim(file.contents("#{state_dir}/say.txt"))
    file.remove("#{state_dir}/say.txt")
    if contents != "" then
      log("DJ says: #{contents}")
      if has_leadin then
        ignore(voice_queue.push(request.create(leadin_path)))
      end
      ignore(voice_queue.push(request.create(contents)))
    end
  end
end
thread.run(every=0.5, poll_voice)

def poll_intro() =
  if file.exists("#{state_dir}/intro.txt") then
    contents = string.trim(file.contents("#{state_dir}/intro.txt"))
    file.remove("#{state_dir}/intro.txt")
    if contents != "" then
      log("DJ talk-over: #{contents}")
      if has_leadin then
        ignore(intro_queue.push(request.create(leadin_path)))
      end
      ignore(intro_queue.push(request.create(contents)))
    end
  end
end
thread.run(every=0.5, poll_intro)

def poll_sfx() =
  if file.exists("#{state_dir}/sfx.txt") then
    contents = string.trim(file.contents("#{state_dir}/sfx.txt"))
    file.remove("#{state_dir}/sfx.txt")
    if contents != "" then
      log("DJ sound effect: #{contents}")
      # No lead-in: an SFX clip is already-rendered audio, and it is meant to
      # start promptly so it lands under the voice.
      ignore(sfx_queue.push(request.create(contents)))
    end
  end
end
thread.run(every=0.5, poll_sfx)

# ---------------------------------------------------------------------------
# MIC CHAIN — broadcast-style processing on both voice channels (numbers
# tuned for an en_GB-alan-medium-ish voice).
# ---------------------------------------------------------------------------
# A FUNCTION (not a shared chain variable) so each call instantiates fresh
# operator nodes — reuse hits "Early computation of source content-type".
# Skipped for the same error on request.queue sources: 80 Hz HPF + 3 kHz
# presence shelf. Revisit on an engine upgrade or LADSPA.
def mic_chain(s) =
  # Broadcast-style compression — fast attack, gentle ratio. Tames Piper's
  # peaks and brings the body of the voice forward without pumping.
  s = compress(
    attack=5.0,
    release=120.0,
    threshold=-18.0,
    ratio=4.0,
    knee=2.0,
    gain=7.0,
    s
  )
  # Final makeup gain on top of the compressor. Lifts the voice another ~3 dB
  # over the broadcast bus so it sits clearly above the ducked music bed.
  s = amplify(1.4, s)
  # NB: a ~40 ms slap echo used to sit here for "studio room". It was removed —
  # combined with the compressor's makeup gain it lifted Piper's silent-passage
  # noise floor and smeared it into an audible ambient wash behind spoken
  # station IDs. The voice is intentionally dry now.
  s
end

# Per-segment voice trim: the controller stamps `liq_amplify` ("<n> dB") per
# spoken clip (settings.tts.gainDb + audio/tts.ts:voiceGainDb) — the same
# ReplayGain mechanism as the music bus. BEFORE mic_chain so the
# fixed-threshold compressor sees a levelled input; the un-annotated lead-in
# plays at unity.
# 40 ms edge fade-IN per clip: some engines cut the WAV hard at the boundary
# and the compressor's makeup gain turns that edge into an audible tick;
# 40 ms zeroes it without softening the first word. BEFORE amplify/mic_chain
# so the compressor never sees the raw edge.
# fade.in ONLY — on a request.queue source this build doesn't know remaining
# time, so fade.out treats the WHOLE clip as inside the fade zone and
# multiplies it to silence (verified: every segment aired as dead air). Tail
# clicks must be faded at WAV-render time.
def edge_fade(s) =
  fade.in(duration=0.04, s)
end

voice = mic_chain(amplify(override="liq_amplify", 1., edge_fade(voice_queue)))
intro = mic_chain(amplify(override="liq_amplify", 1., edge_fade(intro_queue)))

# ---------------------------------------------------------------------------
# SAFETY — fallback to the emergency loop when the source dies
# ---------------------------------------------------------------------------
# If the source dies, play a static "technical difficulties" loop. This is the
# real dead-air guard: `emergency` is an always-ready, non-silent single, so the
# broadcast never has nothing to pull.
#
# POSITION IS LOAD-BEARING (#1300 bug 7). This MUST stay ABOVE **both** the
# studio-bed `add` below AND the three `smooth_add` ducking layers below that.
# They are the same trap wearing two hats: `add` is ready whenever ANY of its
# inputs is ready, so anything mixed into the music chain makes that chain look
# alive even while the music is starved, and a fallback placed BELOW the mix can
# only ever select index 0.
#   * STUDIO BED — the bed is `mksafe(single(bed_path))`, and `mksafe` makes it
#     INFALLIBLE, i.e. ready forever. With `bed_enabled = true` (a documented
#     one-line source edit, see below) a guard under that `add` is dead code
#     again, and the operator who flipped the flag gets silent dead air with no
#     hint of why.
#   * DUCKING — the stdlib implements smooth_add as
#       add(normalize=false, [normal, fallback(track_sensitive=false, [special, blank()])])
#     — that inner fallback falls through to `blank()`, so the special leg is
#     ALWAYS ready and the whole duck stack reports ready regardless of `normal`.
# This guard lived at the bottom of the chain for its whole life and was dead
# code the entire time; when the starve guard started gating jingles off, that
# turned "stingers forever" into digital silence forever: measured on
# subwave-aio-heavy, output at -91.0 dB with the fallback down there versus
# -3.0 dB with it up here — i.e. the loop actually airs.
#
# It also has to stay BELOW `music_meta` and the jingle rotate, so now-playing
# metadata and jingle counting are untouched; and being above the ducking is
# what lets the DJ talk over the emergency loop exactly as over music.
#
# The ~1s fade-in on the emergency branch is NOT a debounce, and must never be
# turned into one. `track_sensitive=false` means this switches the instant
# `music` reports not-ready, and now that it can actually fire it fires on brief
# real gaps too: a cold boot before auto.m3u resolves (measured: a ~100-200ms
# stab of the loop at mixer start) and the odd track seam where dj_queue and
# auto_playlist are both momentarily unready (auto_playlist entries are
# whole-file `subhttp:` downloads, so a slow Navidrome widens that window).
# DELAYING the switch would be the wrong fix — a dead-air guard that waits
# before firing is a guard that doesn't fire, which is exactly the bug class
# repaired above. So fire immediately and ramp the LEVEL instead: a sub-second
# stab stays inaudible, a genuine starve is at full level in about a second, and
# the guard's timing is untouched. The music branch keeps the stdlib's identity
# transition because coming BACK from the loop must be instant — a recovered
# station fading up over its own first second of music is a second bug, not a
# nicety.
#
# It takes BOTH fades below to cover both cases, so don't delete either:
#   * `transitions` fires only when switching FROM one child TO another, and
#     `switch` applies NO transition to its FIRST selection (measured on 2.4.5:
#     the log reads "Switch to emergency." at boot and "Switch to emergency with
#     transition." every time after). Boot is precisely the first selection.
#   * so `emergency` also carries a one-shot fade of its own. fade.in defaults
#     to track_sensitive=false, which memoises the ramp to the source's first
#     frame EVER — right for the cold boot, useless for every later starve,
#     because a looping single never reaches a fresh track boundary. The fade.in
#     operator registers on_track/on_metadata/on_frame callbacks on the emergency
#     single itself; unlike dj_transition's fades on per-track sources, these
#     callbacks don't collect and walk on every frame the loop produces. One per
#     switch; CPU cost only while emergency airs. Not a blocker; escape hatch is
#     static fade.scale + mkfade-ref (stdlib idiom).
# The two compose: at boot the child's own fade ramps; on every later switch the
# transition wraps a fresh ramp around an inner fade already sitting at unity.
# Measured post-fix (100 ms RMS windows): boot -38.5 dB -> -9.0 dB over 1.0s;
# mid-run starve -32.6 dB -> -9.0 dB over 1.0s; recovery a single-window step
# back to music with no ramp; unchanged after 43 switches in one process.
EMERGENCY_FADE_SEC = 1.0
emergency = single("/sounds/emergency.mp3")
# The `: source` casts drop fade.in's extra methods (fade_duration etc.), which
# otherwise refuse to unify with the plain source the identity transition and
# the `music` child are — a type error, not a style choice.
emergency = (fade.in(duration=EMERGENCY_FADE_SEC, emergency) : source)
music =
  fallback(
    id="music_safety",
    track_sensitive=false,
    transitions=[
      # to music — identity, i.e. the stdlib default. No fade on the way back.
      fun (_, back_to_music) -> back_to_music,
      # to emergency — ramp up over EMERGENCY_FADE_SEC.
      fun (_, to_emergency) ->
        (fade.in(duration=EMERGENCY_FADE_SEC, to_emergency) : source)
    ],
    [music, emergency]
  )

# ---------------------------------------------------------------------------
# STUDIO BED — low-level room tone, mixed in BEFORE voice ducking so
# smooth_add ducks it with the music (otherwise it competes with the voice).
# ---------------------------------------------------------------------------

bed_path = "/sounds/bed.mp3"

# Studio bed disabled — the looping ambient bed was audible/annoying under the
# DJ's voice during links. Flip back to `true` to restore it.
#
# Flipping it is safe for the dead-air guard ONLY because the guard now sits
# ABOVE this block, on `music`. `mksafe` below makes the bed infallible, so this
# `add` is permanently ready — build the guard from `music_bus` instead of
# `music` and turning this flag on silently disarms it (#1300 bug 7).
bed_enabled = false

music_bus =
  if bed_enabled and file.exists(bed_path) then
    log("Loading studio bed from #{bed_path}")
    bed = mksafe(single(id="bed", bed_path))
    add(
      normalize=false,
      weights=[1.0, 0.02],   # bed sits ~34 dB below music — barely there
      [music, bed]
    )
  else
    log("Studio bed off (bed_enabled=#{bed_enabled}) — music plays without a bed")
    music
  end

# ---------------------------------------------------------------------------
# DUCKING — gated talkbax, like a broadcast desk
# ---------------------------------------------------------------------------
# `smooth_add` drops the music to a fixed ratio whenever a voice source has
# signal; two stacked layers because the two channels duck to different
# depths (voice_queue heavy ~22%, intro_queue light ~30%).
#
# Gated, NOT RMS-keyed: an earlier RMS sidechain follower drove the music bus
# to -91 dB even with voice_queue empty (git f38a9af). smooth_add cares only
# whether the channel has signal — the talkbax model; quiet phrases get the
# same duck as loud ones, fine on a single-tenant station.

# Heavy duck. duration = fade into/out of the duck; p is a getter.
ducked = smooth_add(
  duration=0.8,     # gentle fade; each voice channel gets a silent lead-in
                    # clip pushed ahead of the speech (see poll_voice /
                    # poll_intro) so this dip completes BEFORE the DJ starts
                    # talking, and ramps back up after.
  p={0.22},         # music drops to 22% (~-13 dB) while voice plays
  normal=music_bus,
  special=voice
)

# Light duck on top for talk-over links — leaves the song you just queued
# audible under the DJ's voice.
radio = smooth_add(
  duration=0.8,     # see note on the heavy-duck layer above — same lead-in
  p={0.30},         # music drops to 30% (~-10 dB) while intro plays
  normal=ducked,
  special=intro
)

# SFX layer on top — short stingers the DJ agent plays under its voice.
# Same gated `smooth_add` pattern as the two voice layers, but only a slight
# duck: the effect is meant to ride BENEATH the DJ (and the music), not
# replace either. `amplify` sets the stinger's level under the voice — both
# the duck depth (p) and this gain are tuning knobs.
sfx_bed = amplify(0.7, sfx_queue)
radio = smooth_add(
  duration=0.3,     # snappier than voice — stingers are short, no lead-in clip
  p={0.7},          # music dips only to 70% (~-3 dB) while an effect plays
  normal=radio,
  special=sfx_bed
)

# NOTE: the jingle rotate lives up on the raw pre-cross music source — see
# the JINGLES block above music_meta for why it cannot sit here.

# NOTE: the emergency dead-air fallback used to sit HERE, and never once fired
# (#1300 bug 7). Everything from `ducked` down is a `smooth_add`, and smooth_add
# is always ready — the stdlib gives its `special` input a `blank()` fallthrough
# and mixes with `add`, which is ready if any input is. A fallback below that
# stack can only ever select index 0. It has been moved ABOVE the duck layers
# AND above the studio-bed `add` (which has the same always-ready property when
# `bed_enabled` is on, via `mksafe`), onto `music` (id="music_safety") — see the
# SAFETY block up there. Do not add a second one down here: a fallback that
# LOOKS like a dead-air guard but structurally cannot fire is exactly what
# caused this bug.

# ---------------------------------------------------------------------------
# IDLE GATE — silence the programme while nobody is listening
# ---------------------------------------------------------------------------
# The controller flips idle_mode over telnet (idle_on/idle_off): the switch
# selects blank() and the whole chain above stops being pulled, frozen
# mid-track. Mounts STAY UP serving silence, so clients connect normally; the
# controller sees a listener on its next poll and playback resumes exactly
# where it froze. Contrast stream_off, which tears the mounts down. A plain
# blank() is safe — the #660 CPU spin was specific to blank.skip. Not
# persisted: a mixer restart always comes back live; the controller
# re-asserts idle if the room is still empty.
idle_mode = ref(false)
radio = switch(
  id="idle_gate",
  track_sensitive=false,
  [({idle_mode()}, blank(id="idle_silence")), ({true}, radio)]
)

# NOTE: blank.skip was REMOVED here (#660). With no music in the chain (fresh
# install, Navidrome down, playlist exhausted) it busy-loops at ~100% CPU and
# starves Icecast (/stream.mp3 404s) — measured in ANY position, so
# reordering doesn't help. The emergency single already covers a dead source;
# don't reintroduce it.

# ---------------------------------------------------------------------------
# MUSIC STARVE GUARD (#1300 bug 7)
# ---------------------------------------------------------------------------
# `rotate` skips unavailable sources, so with the music chain starved
# (Navidrome unreachable, auto.m3u empty or exhausted) the jingle rotate above
# serves stingers back to back forever — and the `emergency` fallback CANNOT
# see it, because `radio` is still available: it is producing jingles. Measured
# on 2.4.5 with an empty auto.m3u: music_ready=false, jingles_ready=true,
# radio_ready=true. That is the bug in one line.
#
# So sample the PRE-rotate chain (music_meta — the same handle on_metadata
# uses) and, once it has been starved for a sustained window, make jingles
# unavailable. The rotate empties, `radio` goes unavailable, and the emergency
# single fires exactly as it was always meant to.
#
# The window is not just a false-positive guard, it IS the "a jingle may cover
# a brief hiccup" behaviour: the chain is legitimately not-ready at a track
# boundary while a request resolves (the controller bounds that at
# SKIP_COMMIT_WAIT_MS = 20s), so a blip is still papered over by a stinger and
# only a sustained outage escalates. Recovery is unconditional: any tick that
# sees the source ready clears the latch, no restart.
#
# Suppressed while the idle gate holds the programme frozen for an empty room —
# "the music source is starved" is not a meaningful claim about a station
# nobody is listening to. Entering idle clears the latch outright, so the first
# listener back gets a full fresh window rather than a stale verdict.
STARVE_GRACE_SEC = 30.0
STARVE_SAMPLE_SEC = 1.0

# The heartbeat below refreshes `at` while the outage lasts. It does NOT need to
# run at the sample rate: the consumer only asks that the marker be younger than
# STARVE_MARKER_STALE_MS (60s, controller/src/broadcast/music-starve-pure.ts).
# At 1.0s that is ~3,600 atomic rewrites an hour — ~28,800 over an eight-hour
# overnight outage — on a state dir that is typically a Docker bind mount and is
# sometimes an SD card or a spinning array. 10s keeps a 6x margin on the stale
# threshold. EDGE writes (latch, recovery, startup) stay immediate: they change
# the state, and the operator UI should see that on the next poll, not up to ten
# seconds later.
STARVE_HEARTBEAT_SEC = 10.0

starved_for = ref(0.0)
starved_since = ref(0.0)
last_marker_write = ref(0.0)

# NEVER let this raise. An uncaught exception inside a thread.run callback kills
# that thread PERMANENTLY — the guard would freeze at whatever it last latched,
# worst case the emergency loop forever with no path back. Observed directly
# while developing this (an EACCES on the write killed the tick outright), and
# the realistic trigger is the same unwritable state mount ensure_tmp_dir
# already defends against. Reporting must not share a failure domain with the
# guard itself.
def write_starve_marker(starved, since) =
  # Stamped for EVERY write, edge or heartbeat, so an edge write also restarts
  # the heartbeat window rather than being followed by a redundant one a second
  # later. Set before the write so a throwing write still spaces out its retries.
  last_marker_write := time()
  try
    file.write(
      data=json.stringify(compact=true, {
        starved = starved,
        since = since,
        at = time()
      }),
      atomic=true,
      temp_dir=starve_tmp_dir,
      "#{state_dir}/music-starved.json"
    )
  catch err do
    log(label="subwave", "music-starved.json write failed (#{err})")
  end
end

# Publish the healthy state at startup so a working station has the file.
write_starve_marker(false, 0.0)

thread.run(every=STARVE_SAMPLE_SEC, fun () -> begin
  if idle_mode() then
    starved_for := 0.0
    if music_starved() then
      music_starved := false
      write_starve_marker(false, 0.0)
    end
  elsif source.is_ready(music_meta) then
    starved_for := 0.0
    if music_starved() then
      music_starved := false
      log(label="subwave", "music source recovered - jingle rotate re-armed")
      write_starve_marker(false, 0.0)
    end
  else
    starved_for := starved_for() + STARVE_SAMPLE_SEC
    if music_starved() then
      # Heartbeat: refreshes `at` so the controller can tell a live outage from
      # a marker left behind by a mixer that died mid-outage. Throttled to
      # STARVE_HEARTBEAT_SEC — see the constant for why the sample rate is the
      # wrong write rate.
      if time() - last_marker_write() >= STARVE_HEARTBEAT_SEC then
        write_starve_marker(true, starved_since())
      end
    elsif starved_for() >= STARVE_GRACE_SEC then
      music_starved := true
      starved_since := time()
      log(
        label="subwave",
        "MUSIC SOURCE STARVED for #{starved_for()}s - jingles gated off, emergency loop takes over"
      )
      write_starve_marker(true, starved_since())
    end
  end
end)

# ---------------------------------------------------------------------------
# BROADCAST BUS — masters preserved; the brick-wall limiter is the ONLY
# processing. A -14 LUFS normaliser, stereo widener and bus compressor were
# all removed — each audibly reshaped the masters. The limiter stays because
# MP3 encoding generates inter-sample peaks ~0.5-1 dB over the source, so
# modern masters (~-0.3 dBFS TP) would clip listeners' decoders without a
# -1 dBFS ceiling. Typically 0 dB of reduction — a safety net, not a tone
# tool.
# ---------------------------------------------------------------------------

radio = compress(
  attack=1.0,
  release=80.0,
  threshold=-1.0,
  ratio=20.0,
  knee=0.5,
  gain=0.0,
  radio
)

# ---------------------------------------------------------------------------
# METADATA — ICY title driven explicitly from the pre-cross on_meta hook so
# it matches now-playing.json. BOTH operators are load-bearing:
#  1. metadata.map strip — kills ALL metadata still flowing through the
#     chain. dj_transition's fades pass initial_metadata=, so ~crossfade
#     seconds after on_meta fires the cross re-emits the OUTGOING track's
#     metadata, which would reach output.icecast and clobber the title back
#     (Icecast frozen one track behind).
#  2. insert_metadata — after the strip, the ONLY source of stream metadata,
#     pushed from on_meta.
# ---------------------------------------------------------------------------
radio = metadata.map(update=false, strip=true, fun(_) -> [], radio)
radio = insert_metadata(radio)

def on_meta(m) =
  title = m["title"]
  artist = m["artist"]
  album = m["album"]
  filename = m["filename"]
  subsonic_id = m["subsonic_id"]
  # BEDS — an instrumental the controller pushed into dj_queue for the DJ to
  # talk over BETWEEN songs (broadcast/beds.ts). It rides the music chain but
  # is NOT a song: never reaches now-playing.json, never pushes an ICY title.
  # It carries no title/artist so the gate below would drop it silently — and
  # that silence is the problem: the controller learns "bed on air, air the
  # link now" only from this marker. So branch BEFORE the gate. Same shape
  # and rationale as jingle-playing.json (#997).
  if m["subwave_kind"] == "bed" then
    log("on_meta: bed started (#{filename})")
    bed_on_air := true
    file.write(
      data=json.stringify(compact=true, {
        filename = filename,
        startedAt = time()
      }),
      atomic=true,
      temp_dir=bed_tmp_dir,
      "#{state_dir}/bed-playing.json"
    )
  elsif title != "" or artist != "" then
    bed_on_air := false
    log("on_meta: title=#{title} | artist=#{artist} | album=#{album} | id=#{subsonic_id}")
    ts = int_of_float(time())
    # Build via json.stringify so values with embedded quotes/backslashes
    # (e.g. a title like Fall (From "Rabb Da Radio 3")) are properly escaped —
    # raw string interpolation here produced invalid JSON the UI couldn't parse.
    payload = json.stringify(compact=true, {
      title = title,
      artist = artist,
      album = album,
      subsonic_id = subsonic_id,
      filename = filename,
      timestamp = ts
    })
    # atomic=true (temp file + rename) — the controller re-reads this file
    # every 1.5s and per /now-playing request, and its reader treats ANY parse
    # failure as null; an in-place truncate-then-write here made it possible to
    # observe a half-written JSON and blank the now-playing data for a tick.
    # temp_dir keeps the rename on the state fs — without it the atomicity was
    # silently lost to the cross-device copy fallback (#1240).
    file.write(data=payload, atomic=true, temp_dir=np_tmp_dir, "#{state_dir}/now-playing.json")
    # Push the same metadata onto the Icecast stream so the ICY title
    # tracks the current song instead of lagging a transition behind.
    radio.insert_metadata([
      ("title", title),
      ("artist", artist),
      ("album", album)
    ])
  else
    # Untitled, non-bed metadata (the emergency single, an untagged local
    # file). Nothing to publish — but it still marks the bed's end, and
    # without this reset bed_on_air would latch true and keep the jingle
    # rotate starved until the next tagged song.
    bed_on_air := false
  end
end

# Attach to the PRE-cross source (`music_meta`, captured above before the
# cross wrap). Hooking the post-cross source fires twice per transition —
# dj_transition's fade.in/fade.out both pass initial_metadata=, and the
# outgoing track usually wins, freezing the UI one song behind.
# on_metadata is used instead of on_track because on_track gets swallowed
# by source switches (request queue → auto playlist).
# synchronous=false (2.3+ mandatory arg): on_meta does file I/O — run it on
# the task queue, not the streaming thread.
music_meta.on_metadata(synchronous=false, on_meta)

# ---------------------------------------------------------------------------
# OUTPUT — broadcast to Icecast
# ---------------------------------------------------------------------------

# Stream on/off control. Icecast outputs can't pause, but they can be shut
# down and recreated (the dynamic-sources pattern): stream_off disconnects
# every mount (and stops the hourly archive, built in make_stream_outputs);
# stream_on recreates them. force_start lets recreated outputs start after
# init. State lives in refs, read back over telnet; NOT persisted — a mixer
# restart always comes back on air.
#
# /stream.mp3 is the universal floor and always serves. Its default bitrate
# is 192, not 128: dense brick-walled masters produced audible encode grain
# ("swishy static") at 128 — dropping below 192 reintroduces it. The other
# mounts are opt-in (see the toggles at the top); per-listener bandwidth is
# per-mount, so an unused mount costs nothing.
settings.init.force_start := true

# TEMPORARY (re-harden later): allow running as root. The broadcast entrypoint
# currently launches liquidsoap as root (not the privilege-dropped `liquidsoap`
# user) because the 2.4.4 base image changed that user's uid and made the
# persisted state files unwritable — see docker/broadcast-entrypoint.sh. Without
# this, liquidsoap refuses to start under a root euid. Revert together with the
# entrypoint once the state files are re-chowned to the liquidsoap uid.
settings.init.allow_root := true

# Hourly archive path. Wrap in `{time.string(...)}` so the path is a getter that
# re-runs strftime each time `output.file` reopens (every hour via reopen_when).
# Passing the bare string skips strftime entirely and writes everything to one
# literal "%Y-%m-%d/%H-00.mp3" file that gets truncated at the top of each hour.
# Defined here (before make_stream_outputs) because the archive output is built
# inside it, tied to the on-air lifecycle.
archive_path = {time.string("#{state_dir}/archive/%Y-%m-%d/%H-00.mp3")}

def make_stream_outputs() =
  # Pick the encoder from a fixed set: %mp3(bitrate=…) needs a parse-time
  # literal int (can't pass a ref), same constraint as the archive output
  # below. Keep these branches in sync with MP3_BITRATES in settings.ts.
  br = stream_bitrate()
  mp3_enc =
    if br <= 64 then
      %mp3(bitrate=64, samplerate=44100, stereo=true)
    elsif br <= 96 then
      %mp3(bitrate=96, samplerate=44100, stereo=true)
    elsif br <= 128 then
      %mp3(bitrate=128, samplerate=44100, stereo=true)
    elsif br <= 160 then
      %mp3(bitrate=160, samplerate=44100, stereo=true)
    elsif br <= 192 then
      %mp3(bitrate=192, samplerate=44100, stereo=true)
    else
      %mp3(bitrate=320, samplerate=44100, stereo=true)
    end
  mp3_out = output.icecast(
    mp3_enc,
    id="stream_mp3",
    fallible=true,
    host=environment.get(default="icecast", "ICECAST_HOST"),
    port=7702,
    password=environment.get("ICECAST_SOURCE_PASSWORD"),
    mount="/stream.mp3",
    name=station_name(),
    description="Station entierement generee par IA - musique, voix et textes de synthese - robotariis.com/transparence",
    genre="Various",
    url="http://localhost:7700",
    radio
  )
  # Opus mandates 48 kHz internally — Liquidsoap resamples from the 44.1 kHz
  # source bus. application="audio" is the right tuning for music (vs "voip"
  # or "lowdelay"). 96 kbps is the music-transparent default; the bitrate is
  # selectable from a fixed set because %opus(bitrate=…) needs a parse-time
  # literal (same constraint as %mp3). Keep these branches in sync with
  # OPUS_BITRATES in settings.ts. Gated on opus_enabled so operators can drop
  # the encoder + resample (no-op shutdown when off).
  opus_shutdown =
    if opus_enabled() then
      obr = opus_bitrate()
      opus_enc =
        if obr <= 96 then
          %opus(bitrate=96, samplerate=48000, channels=2, application="audio", vbr="constrained")
        elsif obr <= 128 then
          %opus(bitrate=128, samplerate=48000, channels=2, application="audio", vbr="constrained")
        elsif obr <= 192 then
          %opus(bitrate=192, samplerate=48000, channels=2, application="audio", vbr="constrained")
        elsif obr <= 256 then
          %opus(bitrate=256, samplerate=48000, channels=2, application="audio", vbr="constrained")
        else
          %opus(bitrate=320, samplerate=48000, channels=2, application="audio", vbr="constrained")
        end
      opus_out = output.icecast(
        opus_enc,
        id="stream_opus",
        fallible=true,
        # ICY metadata toggle (default ON). output.icecast's null default
        # guesses ICY off for Ogg containers and relies on in-band chained-Ogg
        # re-emission — but many radio clients (Ferrosonic, Cast, Symfonium)
        # read the Ogg comment once at connect and freeze on the first title
        # (#1052), while foobar2000 parses the in-band tags correctly and the
        # ICY channel breaks its Ogg-FLAC metadata. No single value suits both
        # camps, hence the toggle.
        send_icy_metadata=ogg_icy_metadata(),
        host=environment.get(default="icecast", "ICECAST_HOST"),
        port=7702,
        password=environment.get("ICECAST_SOURCE_PASSWORD"),
        mount="/stream.opus",
        name=station_name(),
        description="Station entierement generee par IA - musique, voix et textes de synthese - robotariis.com/transparence",
        genre="Various",
        url="http://localhost:7700",
        radio
      )
      opus_out.shutdown
    else
      fun () -> ()
    end
  # Ogg-wrapped FLAC (streamable over Icecast, unlike the file-oriented native
  # %flac). No resample — stays at the source 44.1 kHz. FLAC is lossless so
  # there's no bitrate; compression=5 is the FLAC default (CPU/size balance) and
  # bits_per_sample=16 is CD-quality and universally decodable. Gated on
  # flac_enabled so the encoder only runs when an operator opts in.
  flac_shutdown =
    if flac_enabled() then
      flac_out = output.icecast(
        %ogg(
          %flac(
            samplerate=44100,
            channels=2,
            compression=5,
            bits_per_sample=16
          )
        ),
        id="stream_flac",
        fallible=true,
        # ICY toggle — see the /stream.opus note above (#1052 vs foobar2000).
        send_icy_metadata=ogg_icy_metadata(),
        host=environment.get(default="icecast", "ICECAST_HOST"),
        port=7702,
        password=environment.get("ICECAST_SOURCE_PASSWORD"),
        mount="/stream.flac",
        name=station_name(),
        description="Station entierement generee par IA - musique, voix et textes de synthese - robotariis.com/transparence (lossless)",
        genre="Various",
        url="http://localhost:7700",
        radio
      )
      flac_out.shutdown
    else
      fun () -> ()
    end
  # AAC-LC over Icecast as raw ADTS (transmux="adts") — broadly decodable by
  # players/hardware that lack Opus. afterburner=true trades a little CPU for
  # better quality. No resample — stays at the source 44.1 kHz. Bitrate is a
  # parse-time literal (same constraint as %mp3/%opus); keep these branches in
  # sync with AAC_BITRATES in settings.ts. format="audio/aac" pins the mount's
  # advertised MIME so streaming clients recognise the ADTS stream.
  aac_shutdown =
    if aac_enabled() then
      abr = aac_bitrate()
      aac_enc =
        if abr <= 128 then
          %fdkaac(bitrate=128, aot="mpeg4_aac_lc", transmux="adts", afterburner=true, samplerate=44100, channels=2)
        elsif abr <= 192 then
          %fdkaac(bitrate=192, aot="mpeg4_aac_lc", transmux="adts", afterburner=true, samplerate=44100, channels=2)
        else
          %fdkaac(bitrate=256, aot="mpeg4_aac_lc", transmux="adts", afterburner=true, samplerate=44100, channels=2)
        end
      aac_out = output.icecast(
        aac_enc,
        id="stream_aac",
        format="audio/aac",
        fallible=true,
        host=environment.get(default="icecast", "ICECAST_HOST"),
        port=7702,
        password=environment.get("ICECAST_SOURCE_PASSWORD"),
        mount="/stream.aac",
        name=station_name(),
        description="Station entierement generee par IA - musique, voix et textes de synthese - robotariis.com/transparence",
        genre="Various",
        url="http://localhost:7700",
        radio
      )
      aac_out.shutdown
    else
      fun () -> ()
    end
  # Hourly archive to /var/sub-wave/archive/. A second MP3 encoder running 24/7
  # is the single biggest CPU cost in the broadcast container — guard the entire
  # output so operators who don't use the archives don't pay for the encoder.
  # Bitrate is selected from a fixed set because `%mp3(bitrate=…)` requires a
  # literal int at parse time (we can't pass a ref). Built here (not standalone)
  # so it lives inside the on-air lifecycle: taking the station off air stops the
  # recording too — otherwise it kept writing hourly files of the internal
  # fallback/emergency loop while off air.
  archive_shutdown =
    if archive_enabled() then
      br = archive_bitrate()
      arch_out =
        if br <= 64 then
          output.file(%mp3(bitrate=64), fallible=true, reopen_when={0m0s}, archive_path, radio)
        elsif br <= 96 then
          output.file(%mp3(bitrate=96), fallible=true, reopen_when={0m0s}, archive_path, radio)
        elsif br <= 128 then
          output.file(%mp3(bitrate=128), fallible=true, reopen_when={0m0s}, archive_path, radio)
        elsif br <= 160 then
          output.file(%mp3(bitrate=160), fallible=true, reopen_when={0m0s}, archive_path, radio)
        elsif br <= 192 then
          output.file(%mp3(bitrate=192), fallible=true, reopen_when={0m0s}, archive_path, radio)
        else
          output.file(%mp3(bitrate=320), fallible=true, reopen_when={0m0s}, archive_path, radio)
        end
      arch_out.shutdown
    else
      log("Hourly archive disabled — set archive.enabled=true in settings to re-enable")
      fun () -> ()
    end
  fun () -> begin
    mp3_out.shutdown()
    opus_shutdown()
    flac_shutdown()
    aac_shutdown()
    archive_shutdown()
  end
end

stream_shutdown = ref(fun () -> ())
stream_on = ref(false)

def stream_up() =
  if not stream_on() then
    stream_shutdown := make_stream_outputs()
    stream_on := true
  end
end

def stream_down() =
  if stream_on() then
    fn = stream_shutdown()
    fn()
    stream_on := false
    # Off air — drop now-playing.json so the UI stops advertising the last
    # track that played. on_meta rewrites it as soon as we're back on air and
    # the next track's metadata fires; the controller reads a missing file as
    # "nothing playing".
    if file.exists("#{state_dir}/now-playing.json") then
      file.remove("#{state_dir}/now-playing.json")
    end
  end
end

# On air at startup — this also starts the hourly archive (built inside
# make_stream_outputs, so it follows the on-air lifecycle).
stream_up()

# ---------------------------------------------------------------------------
# CONTROL — custom telnet command for the controller to trigger a restart
# after writing new settings. Container restart-policy brings us back ~3s later
# with the new values applied at the top of this script.
# ---------------------------------------------------------------------------
server.register(
  "restart",
  description="Shut down so the container restarts with new settings",
  usage="restart",
  fun(_) -> begin
    log("Restart requested via server command")
    shutdown()
    "OK"
  end
)

# Off air / back on air on demand (stream_up/stream_down above);
# stream_status reports the current state. Operator-only.
server.register(
  "stream_off",
  description="Take the station off air (disconnect the Icecast mount)",
  usage="stream_off",
  fun(_) -> begin
    log("Stream taken off air via server command")
    stream_down()
    "OK"
  end
)

server.register(
  "stream_on",
  description="Bring the station back on air",
  usage="stream_on",
  fun(_) -> begin
    log("Stream brought back on air via server command")
    stream_up()
    "OK"
  end
)

server.register(
  "stream_status",
  description="Report whether the station is on air (on/off)",
  usage="stream_status",
  fun(_) -> if stream_on() then "on" else "off" end
)

# Pause / resume while keeping the mounts up (the idle gate above). Driven
# by the controller's stream-idle monitor. Idempotent, logging only on a
# state change, so the controller can re-assert cheaply after a restart.
server.register(
  "idle_on",
  description="Silence the programme while nobody listens (mounts stay up)",
  usage="idle_on",
  fun(_) -> begin
    if not idle_mode() then
      log("Idle gate ON via server command — programme paused, mounts stay up")
    end
    idle_mode := true
    "OK"
  end
)

server.register(
  "idle_off",
  description="Resume the programme after an idle pause",
  usage="idle_off",
  fun(_) -> begin
    if idle_mode() then
      log("Idle gate OFF via server command — programme resumed")
    end
    idle_mode := false
    "OK"
  end
)

server.register(
  "idle_status",
  description="Report whether the idle gate is active (on/off)",
  usage="idle_status",
  fun(_) -> if idle_mode() then "on" else "off" end
)

# Skip the current track: .skip() on the final source propagates down the
# chain, force-ending the track; cross then runs the normal dj_transition
# into the next (dj_queue item, else auto). Operator-only.
server.register(
  "skip",
  description="Skip the currently playing track",
  usage="skip",
  fun(_) -> begin
    log("Skip requested via server command")
    radio.skip()
    "OK"
  end
)

# What a skip would air next from dj_queue: "ready" (a resolved request is
# waiting — the fallback will pick it), "resolving" (pushed but still
# downloading; a skip now would fall through to auto.m3u), "empty". The
# controller polls this before issuing `skip` so an operator skip airs the
# committed pick rather than a random auto.m3u fill (#1300 bug 6). A request
# already popped for boundary prefetch is in neither state here — same
# blind spot dj_queue_remove documents — and reads as "empty", which the
# caller treats as keep-waiting, never as proof of an idle queue.
server.register(
  "dj_queue_status",
  description="Report the pending dj_queue state: ready / resolving / empty",
  usage="dj_queue_status",
  fun(_) -> begin
    q = dj_queue.queue()
    if list.length(q) == 0 then
      "empty"
    else
      ready = list.filter(fun(r) -> request.status(r) == "ready", q)
      if list.length(ready) > 0 then "ready" else "resolving" end
    end
  end
)

# Remove a PENDING request from dj_queue by RID. Anything on air or already
# pulled as the next source is no longer in .queue() → NOT_FOUND, which the
# caller treats as "too late to cancel". Used by DELETE /dj/queue/:trackId.
# Operator-only.
server.register(
  "dj_queue_remove",
  description="Remove a pending request from dj_queue by request id",
  usage="dj_queue_remove <rid>",
  fun(arg) -> begin
    rid = string.trim(arg)
    q = dj_queue.queue()
    matches = list.filter(fun(r) -> "#{request.id(r)}" == rid, q)
    if list.length(matches) == 0 then
      "NOT_FOUND"
    else
      # Removal MUST go through the stdlib's remove(). The old filter +
      # set_queue(kept) rebuild looked equivalent, but set_queue() FLUSHES
      # request.dynamic's inner queue wholesale — and a request already
      # popped for prefetch at a track boundary is in NEITHER visible list
      # while its download runs, so the flush orphaned it (cancelling rids
      # 32+33 silently killed resolving rid 31; observed live, twice). That
      # mid-prefetch request is equally invisible to queue() here, so it
      # reads as NOT_FOUND — "too late to cancel", exactly right.
      list.iter(fun(r) -> dj_queue.remove(r), matches)
      # Destroy the dropped request so its file/URI is released now instead of
      # lingering until Liquidsoap flags it as leaked.
      list.iter(fun(r) -> request.destroy(r), matches)
      log("Removed request #{rid} from dj_queue via server command")
      "OK"
    end
  end
)
