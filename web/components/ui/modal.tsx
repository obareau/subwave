'use client';

import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { cn } from '../../lib/cn';
import { useDynamicStyle } from '../../hooks/useDynamicStyle';

/* V3 Modal — centered, ink-bordered dialog in the admin newsprint style.

   Portals into `.admin-root` rather than <body> so the admin-scoped CSS resolves
   for form controls rendered inside it, falling back to <body> outside the
   admin shell. */
export interface ModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: ReactNode;
  sub?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: number;
}

export function Modal({
  open,
  onOpenChange,
  title,
  sub,
  children,
  footer,
  width = 600,
}: ModalProps) {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setContainer(document.querySelector<HTMLElement>('.admin-root') || document.body);
  }, []);

  // Centering uses the STATIC Tailwind translate classes below, never a
  // post-mount JS transform: a JS-applied transform lands a frame late and makes
  // the dialog visibly jump on open. Width is the only dynamic value, fed in as
  // a CSS var; the `600px` fallback keeps the first paint correct.
  const contentRef = useRef<HTMLDivElement>(null);
  useDynamicStyle(contentRef, { '--modal-w': `${width}px` });

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal container={container}>
        <Dialog.Overlay className="v3-drawer-overlay fixed inset-0 z-40 bg-overlay [backdrop-filter:blur(8px)_saturate(1.1)] [-webkit-backdrop-filter:blur(8px)_saturate(1.1)]" />
        <Dialog.Content
          ref={contentRef}
          aria-describedby={undefined}
          className={cn(
            'v3-modal-pop fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100vh-3rem)] w-[var(--modal-w,600px)] max-w-[calc(100vw-2rem)] flex-col border border-ink bg-[var(--card-bg,var(--bg))] text-ink shadow-drawer outline-none',
            '-translate-x-1/2 -translate-y-1/2',
          )}
        >
          <div className="flex items-baseline justify-between gap-3 border-b border-ink px-5 py-3">
            <div className="flex min-w-0 items-baseline gap-3">
              <Dialog.Title className="eyebrow m-0 whitespace-nowrap text-ink">
                {title}
              </Dialog.Title>
              {sub && <span className="caption truncate">{sub}</span>}
            </div>
            <Dialog.Close
              className="v3-focus cursor-pointer border-0 bg-transparent p-0 text-[22px] leading-none text-muted"
              aria-label="Close"
            >
              ×
            </Dialog.Close>
          </div>

          <div className="v3-scroll flex-1 overflow-auto px-5 py-4">{children}</div>

          {footer && (
            <div className="flex items-center justify-end gap-2 border-t border-ink px-5 py-3">
              {footer}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
