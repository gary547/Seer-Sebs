import { useEffect } from "react";
import { Navigate } from "react-router";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import noBrainerLogoWhite from "@/assets/no-brainer-logo-white-auth.png";

export default function PendingApprovalPage() {
  const { user, loading, approvalStatus, rejectionReason, refreshApproval, signOut } = useAuth();

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

  if (loading) return null;
  if (!user) return <Navigate to="/auth" replace />;
  if (approvalStatus === "approved") return <Navigate to="/dashboard" replace />;

  const isRejected = approvalStatus === "rejected";

  return (
    <div className="min-h-screen w-full relative overflow-hidden bg-obsidian text-obsidian-ink">
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

      <div className="relative z-10 min-h-screen flex flex-col items-center justify-center px-6 py-10">
        <img src={noBrainerLogoWhite} alt="No Brainer" className="h-7 opacity-90 mb-10" />

        <div className="w-full max-w-xl rounded-2xl border border-obsidian-line/70 bg-obsidian-2/60 backdrop-blur-xl shadow-obsidian p-10">
          <p className="font-mono text-[11px] tracking-eyebrow text-obsidian-ink-muted uppercase">
            {isRejected ? "Access denied" : "Awaiting approval"}
          </p>
          <h1 className="mt-3 font-heading font-black tracking-tight text-3xl leading-tight text-obsidian-ink">
            {isRejected ? "Your request was declined." : "You're on the list."}
          </h1>
          <p className="mt-4 font-display italic text-lg text-obsidian-ink-muted">
            {isRejected
              ? "An administrator reviewed your request and chose not to grant access."
              : "An administrator has been notified and will review your request shortly. You'll get the keys once they approve."}
          </p>

          {isRejected && rejectionReason && (
            <div className="mt-6 rounded-xl border border-obsidian-line/60 bg-obsidian/40 p-4">
              <p className="font-mono text-[10px] tracking-eyebrow text-obsidian-ink-muted uppercase mb-1.5">
                Reason
              </p>
              <p className="text-sm text-obsidian-ink">{rejectionReason}</p>
            </div>
          )}

          <div className="mt-8 flex flex-wrap items-center gap-3">
            {!isRejected && (
              <Button
                onClick={() => refreshApproval()}
                className="h-10 px-5 font-medium tracking-tight"
                style={{ background: "var(--gradient-signal)", color: "white" }}
              >
                Check again
              </Button>
            )}
            <Button
              variant="outline"
              onClick={() => signOut()}
              className="h-10 px-5 border-obsidian-line text-obsidian-ink hover:bg-obsidian/40"
            >
              Sign out
            </Button>
          </div>

          {(() => {
            const adminEmail =
              (import.meta.env.VITE_SEER_ADMIN_CONTACT_EMAIL as string | undefined)?.trim() ||
              "support@nobraineragency.com";
            return (
              <p className="mt-6 text-xs text-obsidian-ink-muted">
                Need access sooner?{" "}
                <a
                  href={`mailto:${adminEmail}`}
                  className="font-mono text-obsidian-ink underline decoration-obsidian-line/60 hover:decoration-obsidian-ink"
                >
                  {adminEmail}
                </a>
              </p>
            );
          })()}

          <p className="mt-4 text-xs text-obsidian-ink-muted/70">
            Signed in as <span className="font-mono">{user.email}</span>
          </p>
        </div>

        <p className="mt-8 font-mono text-[10px] tracking-eyebrow text-obsidian-ink-muted/70 uppercase">
          Seer® · A No Brainer product
        </p>
      </div>
    </div>
  );
}
