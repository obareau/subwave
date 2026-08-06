'use client';

import { useEffect } from 'react';

// Registers /sw.js once on mount. Separate from PlayerApp so it also runs on
// the landing/admin/setup routes, wherever the visitor lands first.
export default function ServiceWorkerRegister(): null {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator)) return;

    // Production-only: in dev the SW precaches hashed webpack chunks that go
    // stale on every `next dev` restart, surfacing as a cryptic "Cannot read
    // properties of undefined (reading 'call')". Actively tear down any SW +
    // caches a prior prod build left on this origin, or the stale SW keeps
    // serving broken chunks and the page never recovers on its own.
    if (process.env.NODE_ENV !== 'production') {
      navigator.serviceWorker
        .getRegistrations()
        .then((regs) => regs.forEach((r) => r.unregister()))
        .catch(() => {});
      if ('caches' in window) {
        caches.keys().then((keys) => keys.forEach((k) => caches.delete(k))).catch(() => {});
      }
      return;
    }

    if (window.location.protocol !== 'https:' && window.location.hostname !== 'localhost') {
      // Browsers refuse SW over plain HTTP on non-localhost hosts; skipping the
      // call avoids a noisy console error.
      return;
    }
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('[sw] registration failed:', err);
    });
  }, []);
  return null;
}
