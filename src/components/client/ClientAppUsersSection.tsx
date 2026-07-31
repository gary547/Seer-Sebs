import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useAdminUsers } from "@/hooks/useAdminUsers";
import { UserPlus, X } from "lucide-react";
import {
  grantClientUser,
  listClientUsers,
  revokeClientUser,
} from "@/integrations/gcp/tenancy";

interface Props {
  clientId: string;
}

interface AccessRow {
  user_id: string;
  email: string | null;
  full_name: string | null;
  role: string | null;
}

export default function ClientAppUsersSection({ clientId }: Props) {
  const { canManageUsers } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: rows, isLoading, refetch } = useQuery({
    queryKey: ["client-app-users", clientId],
    enabled: canManageUsers,
    queryFn: (): Promise<AccessRow[]> => listClientUsers(clientId),
  });

  const { data: allUsers } = useAdminUsers(canManageUsers);

  const [grantOpen, setGrantOpen] = useState(false);

  if (!canManageUsers) return null;

  const eligibleToGrant = (allUsers ?? []).filter(
    (u) => !rows?.some((r) => r.user_id === u.id)
  );

  const handleRevoke = async (userId: string, email: string | null) => {
    if (!confirm(`Revoke ${email}'s access to this client?`)) return;
    try {
      await revokeClientUser(clientId, userId);
      toast({ title: "Access revoked" });
      refetch();
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    } catch (error) {
      toast({
        title: "Error",
        description:
          error instanceof Error ? error.message : "Access revocation failed.",
        variant: "destructive",
      });
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">App Users with Access</CardTitle>
        <CardDescription>
          People who can log into Seer® and view this client's data.
          <br />
          <span className="text-xs">
            Different from "Team Members" above (descriptive contacts only — no login).
          </span>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !rows?.length ? (
          <p className="text-sm text-muted-foreground italic">No users have explicit access yet.</p>
        ) : (
          <div className="space-y-2">
            {rows.map((r) => (
              <div key={r.user_id} className="flex items-center justify-between rounded-lg border bg-card p-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{r.full_name || r.email}</p>
                  <p className="text-xs text-muted-foreground truncate">{r.email}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className="capitalize">{r.role?.replace("_", " ") ?? "—"}</Badge>
                  <Button type="button" variant="ghost" size="icon" onClick={() => handleRevoke(r.user_id, r.email)}>
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="flex gap-2 pt-2">
          <Button type="button" variant="outline" onClick={() => setGrantOpen(true)}>
            <UserPlus className="h-4 w-4 mr-1" /> Grant existing user
          </Button>
        </div>

        {grantOpen && (
          <GrantDialog
            clientId={clientId}
            users={eligibleToGrant.map((u) => ({ id: u.id, email: u.email, full_name: u.full_name, role: u.role }))}
            onClose={() => setGrantOpen(false)}
            onSaved={() => {
              setGrantOpen(false);
              refetch();
              queryClient.invalidateQueries({ queryKey: ["admin-users"] });
            }}
          />
        )}

      </CardContent>
    </Card>
  );
}

function GrantDialog({
  clientId,
  users,
  onClose,
  onSaved,
}: {
  clientId: string;
  users: { id: string; email: string | null; full_name: string | null; role: string | null }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [selected, setSelected] = useState<string>("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      await grantClientUser(clientId, selected);
      toast({ title: "Access granted" });
      onSaved();
    } catch (error) {
      toast({
        title: "Error",
        description:
          error instanceof Error ? error.message : "Access grant failed.",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Grant access</DialogTitle>
          <DialogDescription>Select an existing user to grant access to this client.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label>User</Label>
          <Select value={selected} onValueChange={setSelected}>
            <SelectTrigger><SelectValue placeholder="Select a user…" /></SelectTrigger>
            <SelectContent>
              {users.map((u) => (
                <SelectItem key={u.id} value={u.id}>
                  {u.full_name || u.email} {u.role && <span className="text-xs text-muted-foreground ml-1">({u.role})</span>}
                </SelectItem>
              ))}
              {!users.length && <div className="px-2 py-1.5 text-sm text-muted-foreground">All users already have access.</div>}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={!selected || saving}>{saving ? "Granting…" : "Grant access"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
