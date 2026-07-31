import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.06em] transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default: "border-transparent bg-ink text-canvas hover:bg-ink/90",
        secondary: "border-hairline bg-surface-sunk text-ink-muted",
        destructive: "border-transparent bg-neg-soft text-neg",
        outline: "border-hairline-strong text-ink-muted bg-transparent",
        signal: "border-transparent bg-signal-soft text-signal-ink",
        pos: "border-transparent bg-pos-soft text-pos",
        warn: "border-transparent bg-warn-soft text-warn",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
