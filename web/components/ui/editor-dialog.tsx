'use client';

import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { AnimatePresence, m } from 'motion/react';
import { MoreHorizontal } from 'lucide-react';
import { cn } from '../../lib/cn';
import { Button } from './button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './dropdown-menu';

/* V3 EditorDialog — the full-screen, edge-to-edge editor used for add/edit of
   shows, personas and skills. One shell, three editors, one consistent shape:

     • header  — title + sub + close, identical across all three (no actions).
     • body    — full-width, scrollable. Sections inside are separated by
                 hairline dividers (see `.card.is-flat`), never boxed cards.
     • footer  — the transport bar; ALL actions live here (save, delete,
                 run, toggles…), so the header stays uniform.

   Why full-screen rather than the centered `Modal`: a `fixed inset-0` panel has
   no width to animate, so it can't reproduce the width-jump glitch that pushed
   the shows/personas editors in-page (#694). It is built on Radix Dialog — so
   focus trap, body scroll-lock and hierarchical Escape come for free — instead
   of a hand-rolled overlay (the old glitchy skills modal).

   Motion mirrors `sheet.tsx`: AnimatePresence + Radix `forceMount` so the exit
   plays before unmount; `<m.div>` (LazyMotion is `strict` — `motion.div` is
   forbidden, see MotionProvider). The content fades + rises (transform/opacity
   only → GPU-composited, no layout shift). Reduced motion is honoured globally
   by `MotionConfig reducedMotion="user"`, so there is no per-component branch.

   It portals into `.admin-root` (falling back to <body>) so the admin-scoped
   class names (`.input` / `.btn` / `.card` / `.eyebrow` …) resolve for the
   form controls rendered inside. Controlled: pass `open` + `onOpenChange`. */
export interface EditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: ReactNode;
  sub?: ReactNode;
  footer?: ReactNode;
  /* Extra class on the content panel — lets a consumer scope its own descendant
     CSS inside (e.g. the skills editor's `.sw-seg` typographic rules). */
  className?: string;
  children?: ReactNode;
}

export function EditorDialog({
  open,
  onOpenChange,
  title,
  sub,
  footer,
  className,
  children,
}: EditorDialogProps) {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setContainer(document.querySelector<HTMLElement>('.admin-root') || document.body);
  }, []);

  // Full-width content with generous side padding — the form fills the modal.
  const column = 'w-full px-5 sm:px-8';

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount container={container}>
            <Dialog.Overlay asChild forceMount>
              <m.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18 }}
                className="fixed inset-0 z-40 bg-overlay [backdrop-filter:blur(8px)_saturate(1.1)] [-webkit-backdrop-filter:blur(8px)_saturate(1.1)]"
              />
            </Dialog.Overlay>
            <Dialog.Content asChild forceMount aria-describedby={undefined}>
              <m.div
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 12 }}
                transition={{ duration: 0.22, ease: [0.2, 0.7, 0.2, 1] }}
                className={cn('fixed inset-0 z-50 flex flex-col bg-bg text-ink outline-none', className)}
              >
                {/* Sticky header — title + sub + close, identical for all editors */}
                <div className="flex-none border-b border-ink">
                  <div className={cn(column, 'flex items-center justify-between gap-3 py-3.5')}>
                    <div className="flex min-w-0 flex-1 items-baseline gap-3">
                      <Dialog.Title asChild>
                        <div className="m-0 min-w-0 flex-1 text-ink">{title}</div>
                      </Dialog.Title>
                      {sub && <div className="flex-none">{sub}</div>}
                    </div>
                    <Dialog.Close
                      className="v3-focus flex-none cursor-pointer border-0 bg-transparent p-0 text-[22px] leading-none text-muted"
                      aria-label="Close"
                    >
                      ×
                    </Dialog.Close>
                  </div>
                </div>

                {/* Scrollable body — full width */}
                <div className="v3-scroll flex-1 overflow-auto">
                  <div className={cn(column, 'py-6')}>
                    {children}
                  </div>
                </div>

                {/* Sticky footer — the transport bar; all actions live here.
                    Padding is tighter on a phone: the footer is fixed furniture
                    stealing height from the form above it. */}
                {footer && (
                  <div className="flex-none border-t border-ink">
                    <div className={cn(column, 'py-2 sm:py-3')}>
                      {footer}
                    </div>
                  </div>
                )}
              </m.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}

/* ── EditorFooter ────────────────────────────────────────────────────────────
   The transport bar shared by the shows / personas / skills editors.

   Each editor used to hand `EditorDialog` its own hand-rolled flex row of `lg`
   buttons with `flex-wrap`. That reads fine on a desktop and falls apart on a
   phone: the skills bar alone (on-air toggle, RUN NOW, EXPORT, DELETE, SHARE TO
   COMMUNITY, CLOSE, SAVE) is ~600px of transport, so it wrapped into four rows
   and ate half the viewport — leaving a sliver of the form the operator is
   actually editing.

   So the footer is data-driven, and the phone gets a different shape rather
   than the same shape reflowed:

     • `primary` (close/save) always stays visible — one row, never wraps.
     • `actions` (the editor-scoped verbs: remove, run, export, share…) render
       inline from `sm:` up, and collapse into a single `⋯` overflow menu below
       it. One button instead of five.
     • `status` gets its own line above, so a long validation message never
       pushes the buttons around.
     • buttons run at the default size on a phone and `lg` from `sm:` up.

   Both branches are rendered and CSS-hidden (not `useIsMobile`) so the footer
   is stable through hydration — a first paint with the wrong branch would jump
   the whole panel. */
export interface EditorAction {
  id: string;
  /** Button label. Text only, please — it doubles as the overflow-menu row. */
  label: ReactNode;
  onClick: () => void;
  tone?: 'default' | 'solid' | 'accent' | 'danger';
  disabled?: boolean;
  title?: string;
  /** Left off the bar entirely (keeps call sites free of `&&` gymnastics). */
  hidden?: boolean;
  /** Leading icon, rendered in both the button and the menu row. */
  icon?: ReactNode;
}

const TONE_VARIANT = {
  default: 'default',
  solid: 'solid',
  accent: 'accent',
  danger: 'destructive',
} as const;

/* Default size on a phone, `lg` from sm: up — mirrors buttonVariants' `lg`. */
const RESPONSIVE_SIZE = 'sm:px-[22px] sm:py-[11px] sm:text-[11px]';

function ActionButton({ action, className }: { action: EditorAction; className?: string }) {
  return (
    <Button
      type="button"
      variant={TONE_VARIANT[action.tone || 'default']}
      onClick={action.onClick}
      disabled={action.disabled}
      title={action.title}
      className={cn(RESPONSIVE_SIZE, className)}
    >
      {action.icon}
      {action.label}
    </Button>
  );
}

export interface EditorFooterProps {
  /** Validation / hint line. Rendered on its own row above the buttons. */
  status?: ReactNode;
  /** Always-visible control that isn't a button (the skills on-air toggle). */
  extra?: ReactNode;
  /** Editor-scoped verbs. Inline on desktop, `⋯` overflow menu on a phone. */
  actions?: EditorAction[];
  /** Close / save. Always visible, always last. */
  primary?: EditorAction[];
}

export function EditorFooter({ status, extra, actions = [], primary = [] }: EditorFooterProps) {
  const visible = actions.filter(a => !a.hidden);
  const primaryVisible = primary.filter(a => !a.hidden);

  return (
    <div className="flex w-full flex-col gap-2">
      {status && (
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-[11px] leading-snug text-muted">
          {status}
        </div>
      )}
      <div className="flex items-center gap-2 sm:gap-3">
        {extra}

        {/* phone — every secondary verb behind one trigger */}
        {visible.length > 0 && (
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="default"
                size="icon"
                className="sm:hidden"
                aria-label="More actions"
              >
                <MoreHorizontal aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="top" className="min-w-[11rem]">
              {visible.map(a => (
                <DropdownMenuItem
                  key={a.id}
                  disabled={a.disabled}
                  onSelect={a.onClick}
                  className={cn(a.tone === 'danger' && 'text-[var(--danger)]')}
                >
                  {a.icon}
                  {a.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        {/* desktop — the same verbs, spelled out */}
        {visible.length > 0 && (
          <div className="hidden flex-wrap items-center gap-2 sm:flex sm:gap-3">
            {visible.map(a => <ActionButton key={a.id} action={a} />)}
          </div>
        )}

        <div className="ml-auto flex min-w-0 items-center gap-2 sm:gap-3">
          {primaryVisible.map(a => <ActionButton key={a.id} action={a} />)}
        </div>
      </div>
    </div>
  );
}
