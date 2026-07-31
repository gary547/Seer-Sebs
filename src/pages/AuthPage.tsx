import { useEffect, useState } from "react";
import { Navigate, useLocation } from "react-router";
import { useAuth } from "@/contexts/AuthContext";

/**
 * UX-002 (Phase H2): Safely compose the post-auth destination from the
 * `from` location passed by ProtectedRoute. Returns null when the input
 * is missing or fails open-redirect validation, in which case callers
 * should fall back to /dashboard.
 */
function safeFromPath(from: unknown): string | null {
  if (!from || typeof from !== "object") return null;
  const loc = from as { pathname?: unknown; search?: unknown; hash?: unknown };
  const pathname = typeof loc.pathname === "string" ? loc.pathname : null;
  if (!pathname) return null;
  // Must be an absolute same-origin path. Reject protocol-relative ("//evil")
  // and anything with a scheme separator or control characters.
  if (!pathname.startsWith("/")) return null;
  if (pathname.startsWith("//")) return null;
  if (/[\s\\]/.test(pathname)) return null;
  if (pathname.includes(":")) return null;
  // Never bounce back to the auth-related screens.
  if (/^\/(auth|pending-approval|reset-password)(\/|$)/.test(pathname)) return null;
  const search = typeof loc.search === "string" && loc.search.startsWith("?") ? loc.search : "";
  const hash = typeof loc.hash === "string" && loc.hash.startsWith("#") ? loc.hash : "";
  return `${pathname}${search}${hash}`;
}

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import noBrainerLogoWhite from "@/assets/no-brainer-logo-white-auth.png";

export default function AuthPage() {
  const {
    user,
    loading,
    signIn,
    signOut,
    signUp,
    sendPasswordReset,
    approvalStatus,
  } = useAuth();
  const location = useLocation();
  const { toast } = useToast();
  const [mode, setMode] = useState<"login" | "signup" | "forgot">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Per-page noindex/nofollow — restored on unmount
  useEffect(() => {
    const tags: HTMLMetaElement[] = [];
    (["robots", "googlebot"] as const).forEach((name) => {
      let tag = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
      const created = !tag;
      if (!tag) {
        tag = document.createElement("meta");
        tag.setAttribute("name", name);
        document.head.appendChild(tag);
      }
      const previous = tag.getAttribute("content");
      tag.setAttribute("content", "noindex, nofollow");
      tags.push(tag);
      (tag as any).__previous = previous;
      (tag as any).__created = created;
    });
    return () => {
      tags.forEach((tag) => {
        if ((tag as any).__created) tag.remove();
        else if ((tag as any).__previous !== null) tag.setAttribute("content", (tag as any).__previous);
      });
    };
  }, []);

  if (user && !loading) {
    if (approvalStatus !== "approved") {
      return <Navigate to="/pending-approval" replace />;
    }
    const target = safeFromPath((location.state as { from?: unknown } | null)?.from) ?? "/dashboard";
    return <Navigate to={target} replace />;
  }


  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);

    if (mode === "forgot") {
      const { error } = await sendPasswordReset(email);
      setSubmitting(false);
      if (error) {
        toast({ title: "Error", description: error.message, variant: "destructive" });
      } else {
        toast({ title: "Check your email", description: "Password reset link sent." });
        setMode("login");
      }
      return;
    }

    const result = mode === "login" ? await signIn(email, password) : await signUp(email, password, fullName);
    setSubmitting(false);

    if (result.error) {
      toast({ title: "Error", description: result.error.message, variant: "destructive" });
    } else if (mode === "signup") {
      await signOut();
      toast({
        title: "Account created",
        description:
          "Check your email to verify the address. An admin will then review your access request.",
      });
      setMode("login");
      setPassword("");
      setFullName("");
    }
  };

  const today = new Date().toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).toUpperCase();

  const headlineByMode = {
    login: { eyebrow: "Sign in", title: "Welcome back.", lede: "Open the briefing." },
    signup: { eyebrow: "Create account", title: "Join the room.", lede: "Set up your access to Seer®." },
    forgot: { eyebrow: "Reset password", title: "Forgot it?", lede: "We'll email you a fresh link." },
  }[mode];

  return (
    <div className="min-h-screen w-full relative overflow-hidden bg-obsidian text-obsidian-ink">
      {/* Ambient halos — deck-style three-blob composition */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-32 -right-24 h-[520px] w-[520px] rounded-full opacity-60 blur-3xl"
        style={{ background: "radial-gradient(circle, hsl(var(--signal-3) / 0.55), transparent 65%)" }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute top-1/3 right-1/4 h-[560px] w-[560px] rounded-full opacity-50 blur-3xl"
        style={{ background: "radial-gradient(circle, hsl(var(--signal-2) / 0.55), transparent 65%)" }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-40 -right-10 h-[640px] w-[640px] rounded-full opacity-55 blur-3xl"
        style={{ background: "radial-gradient(circle, hsl(var(--signal) / 0.55), transparent 65%)" }}
      />

      <div className="relative z-10 min-h-screen grid grid-cols-1 lg:grid-cols-[1.15fr_1fr]">
        {/* Editorial column */}
        <section className="hidden lg:flex flex-col justify-between px-12 xl:px-16 py-10">
          <div className="flex items-center gap-3">
            <img src={noBrainerLogoWhite} alt="No Brainer" className="h-7 opacity-90" />
          </div>

          <div className="max-w-2xl">
            <p className="font-mono text-[11px] tracking-eyebrow text-obsidian-ink-muted uppercase">
              {today} · MORNING BRIEFING
            </p>
            <h1 className="mt-6 font-heading font-black tracking-tight text-5xl xl:text-6xl leading-[0.95] text-obsidian-ink">
              {headlineByMode.title}
            </h1>
            <p className="mt-4 font-heading font-black tracking-tight text-5xl xl:text-6xl leading-[0.95] text-gradient-signal">
              {headlineByMode.lede}
            </p>
            <p className="mt-8 font-display italic text-lg text-obsidian-ink-muted max-w-lg">
              Seer® turns search insights into significant commercial growth.
            </p>
          </div>

          <p className="font-mono text-[11px] tracking-eyebrow text-obsidian-ink-muted uppercase">
            Seer® · A No Brainer product
          </p>
        </section>

        {/* Auth card column */}
        <section className="flex items-center justify-center px-6 sm:px-10 py-10">
          <div className="w-full max-w-md">
            {/* Mobile-only logo */}
            <div className="lg:hidden mb-8 flex items-center justify-center">
              <img src={noBrainerLogoWhite} alt="No Brainer" className="h-7 opacity-90" />
            </div>

            <div className="rounded-2xl border border-obsidian-line/70 bg-obsidian-2/60 backdrop-blur-xl shadow-obsidian p-8">
              <p className="font-mono text-[11px] tracking-eyebrow text-obsidian-ink-muted uppercase">
                {headlineByMode.eyebrow}
              </p>
              <h2 className="mt-2 font-heading font-bold text-2xl text-obsidian-ink">
                {mode === "login" ? "Open Seer®" : mode === "signup" ? "Request access" : "Email me a link"}
              </h2>

              <form onSubmit={handleSubmit} className="mt-6 space-y-4">
                {mode === "signup" && (
                  <div className="space-y-1.5">
                    <Label htmlFor="fullName" className="text-obsidian-ink-muted text-xs uppercase tracking-eyebrow font-mono">
                      Full name
                    </Label>
                    <Input
                      id="fullName"
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      required
                      className="bg-obsidian/60 border-obsidian-line text-obsidian-ink placeholder:text-obsidian-ink-muted/60 focus-visible:ring-signal h-11"
                    />
                  </div>
                )}
                <div className="space-y-1.5">
                  <Label htmlFor="email" className="text-obsidian-ink-muted text-xs uppercase tracking-eyebrow font-mono">
                    Email
                  </Label>
                  <Input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    className="bg-obsidian/60 border-obsidian-line text-obsidian-ink placeholder:text-obsidian-ink-muted/60 focus-visible:ring-signal h-11"
                  />
                </div>
                {mode !== "forgot" && (
                  <div className="space-y-1.5">
                    <Label htmlFor="password" className="text-obsidian-ink-muted text-xs uppercase tracking-eyebrow font-mono">
                      Password
                    </Label>
                    <Input
                      id="password"
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      minLength={10}
                      className="bg-obsidian/60 border-obsidian-line text-obsidian-ink placeholder:text-obsidian-ink-muted/60 focus-visible:ring-signal h-11"
                    />
                  </div>
                )}
                <Button
                  type="submit"
                  disabled={submitting}
                  className="w-full h-11 bg-signal hover:bg-signal/90 text-signal-foreground font-medium tracking-tight"
                  style={{ background: submitting ? undefined : "var(--gradient-signal)", color: "white" }}
                >
                  {submitting
                    ? "Please wait…"
                    : mode === "login"
                    ? "Sign in"
                    : mode === "signup"
                    ? "Create account"
                    : "Send reset link"}
                </Button>
              </form>

              <div className="mt-6 pt-5 border-t border-obsidian-line/60 text-center text-sm space-y-2">
                {mode === "login" && (
                  <>
                    <button
                      type="button"
                      className="text-signal hover:underline block mx-auto font-medium"
                      onClick={() => setMode("forgot")}
                    >
                      Forgot password?
                    </button>
                    <button
                      type="button"
                      className="text-obsidian-ink-muted hover:text-obsidian-ink transition-colors block mx-auto"
                      onClick={() => setMode("signup")}
                    >
                      Don't have an account? <span className="underline">Sign up</span>
                    </button>
                  </>
                )}
                {(mode === "signup" || mode === "forgot") && (
                  <button
                    type="button"
                    className="text-obsidian-ink-muted hover:text-obsidian-ink transition-colors block mx-auto"
                    onClick={() => setMode("login")}
                  >
                    ← Back to sign in
                  </button>
                )}
              </div>
            </div>

            <p className="mt-6 text-center font-mono text-[10px] tracking-eyebrow text-obsidian-ink-muted/70 uppercase lg:hidden">
              Seer® · A No Brainer product
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
