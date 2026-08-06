'use client';

import type { ReactNode } from 'react';
import { LazyMotion, MotionConfig, domAnimation } from 'motion/react';

interface MotionProviderProps {
  children: ReactNode;
}

// Single root motion provider.
//
// LazyMotion + domAnimation keeps the bundle to ~12 kB gzip vs ~30 kB for full
// motion. `strict` forbids the non-lazy <motion.div> import so nobody pulls in
// the full bundle later — use <m.div>.
//
// reducedMotion="user" honors the OS preference everywhere without
// per-component code. The default transition mirrors the cubic-bezier used by
// the V3 CSS keyframes (v3-slide-in-right, v3-modal-pop).
export default function MotionProvider({ children }: MotionProviderProps) {
  return (
    <LazyMotion features={domAnimation} strict>
      <MotionConfig
        reducedMotion="user"
        transition={{ duration: 0.22, ease: [0.2, 0.7, 0.2, 1] }}
      >
        {children}
      </MotionConfig>
    </LazyMotion>
  );
}
