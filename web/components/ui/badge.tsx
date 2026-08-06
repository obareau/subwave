import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/cn"

/* Retuned for the newsprint aesthetic; variants map to the legacy `.tag`
   tones (default = muted outline, ink, accent, solid). */
const badgeVariants = cva(
  "inline-flex items-center gap-1.5 border px-2 py-[3px] text-[10px] font-bold tracking-[0.14em] uppercase transition-colors focus:ring-1 focus:ring-ring focus:outline-none",
  {
    variants: {
      variant: {
        default: "border-[color:var(--separator-strong)] text-[color:var(--muted)]",
        ink: "border-ink text-ink",
        accent: "border-[var(--accent)] text-[var(--accent)]",
        solid: "border-ink bg-ink text-bg",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants }
