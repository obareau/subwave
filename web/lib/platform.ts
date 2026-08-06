// Client-only platform detection shared across the player.
//
// iOS / iPadOS is special for two unrelated reasons: its Opus decoder chokes on
// Icecast's chained-Ogg boundary (usePlayer pins it to MP3), and Safari makes
// HTMLMediaElement.volume read-only while the only software workaround (a Web
// Audio GainNode) risks lock-screen playback and is ignored inside an installed
// PWA, so the transport bar shows a hardware-volume hint instead of a dead
// slider (issue #298).
//
// iPadOS 13+ reports a desktop "Macintosh" UA, so a Mac-UA device reporting
// touch points counts as iOS — no real Mac has a touchscreen.
export function isIOSDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return (
    /iPad|iPhone|iPod/.test(ua) ||
    (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
  );
}
