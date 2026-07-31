import { cn } from "@/lib/utils";

interface ShimmerProps {
  className?: string;
}

export function Shimmer({ className }: ShimmerProps) {
  return <div className={cn("shimmer rounded-lg", className)} />;
}

export function ShimmerCard() {
  return (
    <div className="rounded-xl border border-border bg-card p-5 space-y-3">
      <Shimmer className="h-4 w-1/3" />
      <Shimmer className="h-3 w-2/3" />
      <Shimmer className="h-24 w-full" />
    </div>
  );
}

export function ShimmerTable({ rows = 5 }: { rows?: number }) {
  return (
    <div className="rounded-xl border border-border bg-card p-5 space-y-2">
      <Shimmer className="h-4 w-1/4 mb-4" />
      {Array.from({ length: rows }).map((_, i) => (
        <Shimmer key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}

export function ShimmerStat() {
  return (
    <div className="space-y-2">
      <Shimmer className="h-3 w-20" />
      <Shimmer className="h-6 w-28" />
      <Shimmer className="h-2.5 w-16" />
    </div>
  );
}

export function ShimmerHeader() {
  return (
    <div className="space-y-2">
      <Shimmer className="h-3 w-24" />
      <Shimmer className="h-7 w-1/3" />
      <Shimmer className="h-3 w-1/2" />
    </div>
  );
}
