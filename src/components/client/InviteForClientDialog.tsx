import { useState } from "react";
import { inviteAdminUser } from "@/integrations/gcp/admin-users";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";

interface Props {
  clientId: string;
  callerRole: string | null;
  onClose: () => void;
  onSaved?: () => void;
}

export default function InviteForClientDialog({ clientId, callerRole, onClose, onSaved }: Props) {
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    setSubmitting(true);
    try {
      await inviteAdminUser({
        email: email.trim(),
        fullName: fullName.trim(),
        role: "view_only",
        clientIds: [clientId],
      });
      toast({ title: "User invited", description: `Invitation sent to ${email}.` });
      onSaved?.();
      onClose();
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Invitation failed.",
        variant: "destructive",
      });
    }
    setSubmitting(false);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite new user</DialogTitle>
          <DialogDescription>
            They'll get an email with a link to set their password, then sign in with <strong>view-only</strong> access to this client.
            {callerRole === "super_admin" || callerRole === "admin" ? (
              <span className="block mt-1 text-xs">
                Need to grant a higher role? Use the Admin → Users page instead.
              </span>
            ) : null}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Email</Label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Full name</Label>
            <Input value={fullName} onChange={(e) => setFullName(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={submitting || !email.trim()}>{submitting ? "Inviting…" : "Send invite"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
