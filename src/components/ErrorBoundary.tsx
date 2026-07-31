import { Component, ErrorInfo, ReactNode } from "react";
import { AlertTriangle, RefreshCw, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface Props {
  children: ReactNode;
  /** Optional friendly label for where the error came from (e.g. "Clients page"). */
  scope?: string;
}

interface State {
  error: Error | null;
  info: ErrorInfo | null;
}

/**
 * Catches render-time errors anywhere in the tree below it and shows a
 * clear, human-friendly explanation instead of a blank screen.
 *
 * Pair this with the global window listeners in `main.tsx` which surface
 * uncaught runtime + promise errors as toast notifications.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): State {
    return { error, info: null };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ info });
    // Also log to the browser console for local diagnostics.
    console.error("[ErrorBoundary]", this.props.scope ?? "app", error, info);
  }

  private reset = () => {
    this.setState({ error: null, info: null });
  };

  private copyDetails = async () => {
    const { error, info } = this.state;
    const payload = [
      `Scope: ${this.props.scope ?? "app"}`,
      `Message: ${error?.message ?? "Unknown error"}`,
      `Stack:\n${error?.stack ?? "(no stack)"}`,
      `Component stack:${info?.componentStack ?? "\n(none)"}`,
    ].join("\n\n");
    try {
      await navigator.clipboard.writeText(payload);
      toast.success("Error details copied", { description: "Paste this when reporting the issue." });
    } catch {
      toast.error("Could not copy to clipboard");
    }
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="min-h-[60vh] flex items-center justify-center p-6">
        <div className="max-w-xl w-full rounded-lg border border-destructive/30 bg-destructive/5 p-6 space-y-4">
          <div className="flex items-start gap-3">
            <div className="rounded-full bg-destructive/15 p-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="text-lg font-semibold text-destructive">
                Something went wrong{this.props.scope ? ` in ${this.props.scope}` : ""}
              </h2>
              <p className="text-sm text-muted-foreground mt-1">
                The page hit an unexpected error. Your data is safe — this is just the UI failing to render.
              </p>
            </div>
          </div>

          <div className="rounded-md bg-background border p-3 font-mono text-xs text-foreground/90 break-words">
            {error.message || "Unknown error"}
          </div>

          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer select-none">What does this mean?</summary>
            <p className="mt-2 leading-relaxed">
              A component crashed while rendering. This is usually caused by missing data,
              an unexpected response from the API, or a bug we haven't seen before.
              Try refreshing — if it keeps happening, copy the details and share them
              so we can fix it.
            </p>
          </details>

          <div className="flex flex-wrap gap-2">
            <Button onClick={this.reset} size="sm" variant="default" className="gap-1.5">
              <RefreshCw className="h-3.5 w-3.5" />
              Try again
            </Button>
            <Button onClick={() => window.location.reload()} size="sm" variant="outline">
              Reload page
            </Button>
            <Button onClick={this.copyDetails} size="sm" variant="ghost" className="gap-1.5">
              <Copy className="h-3.5 w-3.5" />
              Copy details
            </Button>
          </div>
        </div>
      </div>
    );
  }
}
