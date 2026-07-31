import { useState, useEffect } from "react";
import { Link, useNavigate } from "react-router";
import { authGateway } from "@/integrations/gcp/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";

type Status = "verifying" | "ready" | "invalid";

export default function ResetPasswordPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<Status>("verifying");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [resetCode, setResetCode] = useState<string>("");

  useEffect(() => {
    let active = true;
    const url = new URL(window.location.href);
    const code = url.searchParams.get("oobCode");
    const mode = url.searchParams.get("mode");
    const errorParam =
      url.searchParams.get("error_description") || url.searchParams.get("error");

    const init = async () => {
      if (errorParam) {
        if (!active) return;
        setErrorMsg(decodeURIComponent(errorParam.replace(/\+/g, " ")));
        setStatus("invalid");
        return;
      }

      if (!code || (mode && mode !== "resetPassword")) {
        if (!active) return;
        setErrorMsg("No valid password reset code was found.");
        setStatus("invalid");
        return;
      }

      try {
        await authGateway().verifyPasswordReset(code);
        if (!active) return;
        setResetCode(code);
        setStatus("ready");
      } catch (error) {
        if (!active) return;
        setErrorMsg(
          error instanceof Error
            ? error.message
            : "Reset link is invalid or has expired.",
        );
        setStatus("invalid");
      }
    };

    void init();

    return () => {
      active = false;
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      toast({ title: "Passwords don't match", variant: "destructive" });
      return;
    }
    if (password.length < 8) {
      toast({ title: "Password must be at least 8 characters", variant: "destructive" });
      return;
    }
    setSubmitting(true);
    try {
      await authGateway().confirmPasswordReset(resetCode, password);
      await authGateway().signOut();
    } catch (error) {
      setSubmitting(false);
      toast({
        title: "Could not update password",
        description:
          error instanceof Error ? error.message : "The reset link is invalid.",
        variant: "destructive",
      });
      return;
    }
    setSubmitting(false);
    toast({ title: "Password updated", description: "Please sign in with your new password." });
    navigate("/auth", { replace: true });
  };

  if (status === "verifying") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-primary p-4">
        <Card className="w-full max-w-sm">
          <CardContent className="p-6 text-center text-muted-foreground">
            Verifying reset link…
          </CardContent>
        </Card>
      </div>
    );
  }

  if (status === "invalid") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-primary p-4">
        <Card className="w-full max-w-sm">
          <CardHeader className="text-center">
            <h2 className="text-xl">Reset link invalid</h2>
          </CardHeader>
          <CardContent className="space-y-4 text-center">
            <p className="text-sm text-muted-foreground">
              {errorMsg || "This password reset link is invalid or has expired. Reset links can only be used once."}
            </p>
            <Button asChild className="w-full">
              <Link to="/auth">Back to sign in</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-primary p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <h2 className="text-xl">Set a new password</h2>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="password">New password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="confirm">Confirm password</Label>
              <Input
                id="confirm"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
              />
            </div>
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? "Updating…" : "Update password"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
