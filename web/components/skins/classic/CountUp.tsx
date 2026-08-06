'use client';

import { useEffect, useRef, useState } from 'react';
import { animate } from 'motion/react';

interface CountUpProps {
  value: number;
  className?: string;
}

// Read at call time so a mid-session setting change is respected.
function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Tweens through the in-between integers, unlike OdometerNumber's whole-value
// digit swap. Thousands separators are pinned to en-US so they don't drift with
// the browser locale.
export default function CountUp({ value, className }: CountUpProps) {
  const [display, setDisplay] = useState(value);
  // Seeded so mount snaps to the first value rather than sweeping 0 → N.
  const prevRef = useRef(value);

  useEffect(() => {
    const from = prevRef.current;
    prevRef.current = value;
    if (from === value) return;
    if (prefersReducedMotion()) {
      setDisplay(value);
      return;
    }
    const controls = animate(from, value, {
      duration: 0.9,
      ease: [0.2, 0.7, 0.2, 1],
      onUpdate: (v) => setDisplay(Math.round(v)),
    });
    return () => controls.stop();
  }, [value]);

  return (
    <span className={className} aria-live="polite">
      {display.toLocaleString('en-US')}
    </span>
  );
}
