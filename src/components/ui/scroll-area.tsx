import * as React from "react";

import { cn } from "@/lib/utils";

const ScrollArea = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, children, ...props }, ref) => (
  <div ref={ref} className={cn("relative overflow-auto", className)} {...props}>
    {children}
  </div>
));
ScrollArea.displayName = "ScrollArea";

const ScrollBar = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { orientation?: "vertical" | "horizontal" }
>(({ className, orientation = "vertical", ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "pointer-events-none absolute bg-border/70",
      orientation === "vertical" && "right-0 top-0 h-full w-1",
      orientation === "horizontal" && "bottom-0 left-0 h-1 w-full",
      className,
    )}
    {...props}
  />
));
ScrollBar.displayName = "ScrollBar";

export { ScrollArea, ScrollBar };
