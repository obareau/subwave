"use client"

import * as React from "react"
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area"

import { cn } from "@/lib/cn"

const ScrollArea = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root>
>(({ className, children, ...props }, ref) => (
  <ScrollAreaPrimitive.Root
    ref={ref}
    className={cn("group/scroll-area relative overflow-hidden", className)}
    {...props}
  >
    {/* max-h-[inherit] mirrors any max-h-* cap from the root onto the viewport:
        `h-full` alone can't resolve against a parent whose height is only
        max-constrained, so capped ScrollAreas would never scroll.

        overscroll-*-contain stops a capped list handing the wheel straight to
        the page the instant it bottoms out. The admin pages stack several of
        these in one column, so chaining reads as the page lurching out from
        under the list you were reading — measured at a 400px jump on
        /admin/dash. It also keeps a sideways swipe on the schedule board off
        the browser's back-navigation gesture.

        It has to be applied PER AXIS and only when that axis really scrolls.
        Radix sets `overflow: scroll` on the viewport for any axis that has a
        ScrollBar mounted, whether or not the content overflows, so a blanket
        `overscroll-contain` swallows the wheel over the many admin areas that
        never scroll — measured: the page froze completely. The scrollbar
        element is the reliable signal, because Radix's auto layer mounts it
        only while that axis overflows and keeps it in sync with a
        ResizeObserver. Match it from the ROOT rather than as a sibling of the
        viewport: the default vertical bar is a sibling, but a horizontal one is
        passed as a CHILD by the caller and so renders inside the viewport —
        a `:has(~ ...)` rule sees the first and misses the second. */}
    <ScrollAreaPrimitive.Viewport
      className="h-full max-h-[inherit] w-full rounded-[inherit] group-has-[div[data-orientation=horizontal]]/scroll-area:overscroll-x-contain group-has-[div[data-orientation=vertical]]/scroll-area:overscroll-y-contain"
    >
      {children}
    </ScrollAreaPrimitive.Viewport>
    <ScrollBar />
    <ScrollAreaPrimitive.Corner />
  </ScrollAreaPrimitive.Root>
))
ScrollArea.displayName = ScrollAreaPrimitive.Root.displayName

const ScrollBar = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>
>(({ className, orientation = "vertical", ...props }, ref) => (
  <ScrollAreaPrimitive.ScrollAreaScrollbar
    ref={ref}
    orientation={orientation}
    // forceMount keeps the bar in the DOM for as long as the axis overflows, so
    // hovering FADES it rather than mounting it — the default hover type mounts
    // at opacity 1 and unmounts on pointerleave, which pops the bar in and out
    // as the cursor drifts across the panel. Radix's hover wrapper deliberately
    // does not forward forceMount to the auto layer beneath it, so an area with
    // nothing to scroll still renders no bar at all, and the thumb's rAF loop
    // still only runs while a scroll is in flight.
    forceMount
    className={cn(
      "flex touch-none opacity-0 transition-opacity duration-150 select-none",
      "data-[state=hidden]:pointer-events-none data-[state=visible]:opacity-100",
      orientation === "vertical" &&
        "h-full w-2.5 border-l border-l-transparent p-[1px]",
      orientation === "horizontal" &&
        "h-2.5 flex-col border-t border-t-transparent p-[1px]",
      className
    )}
    {...props}
  >
    <ScrollAreaPrimitive.ScrollAreaThumb className="relative flex-1 rounded-full bg-border" />
  </ScrollAreaPrimitive.ScrollAreaScrollbar>
))
ScrollBar.displayName = ScrollAreaPrimitive.ScrollAreaScrollbar.displayName

export { ScrollArea, ScrollBar }
