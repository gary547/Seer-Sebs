import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  decideAdminUserApproval,
  deleteAdminUser,
  inviteAdminUser,
  replaceAdminUserClientAccess,
  setAdminUserRole,
} from "@/integrations/gcp/admin-users";
import { toDisplayName } from "@/lib/formatName";
import { useAuth } from "@/contexts/AuthContext";
import { useAdminUsers, AdminUser } from "@/hooks/useAdminUsers";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { Navigate } from "react-router";
import { Plus, Trash2, Shield, UsersRound, Check, X, Clock } from "lucide-react";
import { useClients } from "@/hooks/useClients";

const ROLES = [
  { value: "view_only", label: "View only" },
  { value: "user", label: "User" },
  { value: "admin", label: "Admin" },
  { value: "super_admin", label: "Super admin" },
];

export default function UsersPage() {
  const { canManageUsers, role: callerRole, user: currentUser } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: users, isLoading } = useAdminUsers(canManageUsers);
  const { clients } = useClients(canManageUsers);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [accessUser, setAccessUser] = useState<AdminUser | null>(null);
  const [approveUser, setApproveUser] = useState<AdminUser | null>(null);
  const [rejectUser, setRejectUser] = useState<AdminUser | null>(null);

  const { pending, others } = useMemo(() => {
    const list = users ?? [];
    return {
      pending: list.filter((u) => u.approval_status === "pending"),
      others: list.filter((u) => u.approval_status !== "pending"),
    };
  }, [users]);

  if (!canManageUsers) return <Navigate to="/clients" replace />;

  const handleSetRole = async (userId: string, newRole: string) => {
    try {
      await setAdminUserRole(userId, newRole);
      toast({ title: "Role updated" });
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Role update failed.",
        variant: "destructive",
      });
    }
  };

  const handleDelete = async (u: AdminUser) => {
    if (!confirm(`Delete ${u.email}? This cannot be undone.`)) return;
    try {
      await deleteAdminUser(u.id);
      toast({ title: "User deleted" });
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "User deletion failed.",
        variant: "destructive",
      });
    }
  };

  const renderApprovalBadge = (status: AdminUser["approval_status"]) => {
    if (status === "approved") return null;
    if (status === "pending")
      return <Badge variant="outline" className="ml-2 border-amber-500/50 text-amber-600 dark:text-amber-400">Pending</Badge>;
    return <Badge variant="destructive" className="ml-2">Rejected</Badge>;
  };

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1>Users</h1>
          <p className="text-sm text-muted-foreground mt-1">Approve sign-ups, manage roles and client access.</p>
        </div>
        <InviteUserDialog
          open={inviteOpen}
          onOpenChange={setInviteOpen}
          clients={clients}
          callerRole={callerRole}
          onInvited={() => {
            queryClient.invalidateQueries({ queryKey: ["admin-users"] });
          }}
        />
      </div>

      {/* Pending approvals */}
      {pending.length > 0 && (
        <Card className="border-amber-500/30">
          <div className="flex items-center gap-2 p-4 border-b border-amber-500/20 bg-amber-500/5">
            <Clock className="h-4 w-4 text-amber-600 dark:text-amber-400" />
            <h2 className="text-sm font-semibold">Pending approvals</h2>
            <Badge variant="outline" className="border-amber-500/50 text-amber-600 dark:text-amber-400">
              {pending.length}
            </Badge>
          </div>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Signed up</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pending.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell className="font-medium">{u.email}</TableCell>
                    <TableCell>{u.full_name ?? "—"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(u.created_at).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="text-right space-x-2">
                      <Button size="sm" variant="default" onClick={() => setApproveUser(u)}>
                        <Check className="h-3.5 w-3.5 mr-1" /> Approve
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setRejectUser(u)}>
                        <X className="h-3.5 w-3.5 mr-1" /> Reject
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 text-center text-muted-foreground">Loading…</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Client access</TableHead>
                  <TableHead>Last sign-in</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {others.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell className="font-medium">
                      {u.email}
                      {currentUser?.id === u.id && <Badge variant="outline" className="ml-2">you</Badge>}
                      {renderApprovalBadge(u.approval_status)}
                    </TableCell>
                    <TableCell>{u.full_name ?? "—"}</TableCell>
                    <TableCell>
                      {callerRole === "super_admin" ? (
                        <Select value={u.role ?? ""} onValueChange={(v) => handleSetRole(u.id, v)}>
                          <SelectTrigger className="w-36 h-8"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {ROLES.map((r) => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      ) : (
                        <Badge variant="secondary" className="capitalize">{u.role?.replace("_", " ") ?? "—"}</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <Button variant="ghost" size="sm" onClick={() => setAccessUser(u)}>
                        <UsersRound className="h-3.5 w-3.5 mr-1" />
                        {u.client_ids.length} client{u.client_ids.length === 1 ? "" : "s"}
                      </Button>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {u.last_sign_in_at ? new Date(u.last_sign_in_at).toLocaleDateString() : "Never"}
                    </TableCell>
                    <TableCell className="text-right space-x-1">
                      {u.approval_status === "rejected" && (
                        <Button size="sm" variant="ghost" onClick={() => setApproveUser(u)}>
                          <Check className="h-3.5 w-3.5 mr-1" /> Approve
                        </Button>
                      )}
                      {callerRole === "super_admin" && currentUser?.id !== u.id && (
                        <Button variant="ghost" size="icon" onClick={() => handleDelete(u)}>
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {accessUser && (
        <ClientAccessDialog
          user={accessUser}
          clients={clients}
          onClose={() => setAccessUser(null)}
          onSaved={() => {
            setAccessUser(null);
            queryClient.invalidateQueries({ queryKey: ["admin-users"] });
          }}
        />
      )}

      {approveUser && (
        <ApproveUserDialog
          user={approveUser}
          clients={clients}
          callerRole={callerRole}
          onClose={() => setApproveUser(null)}
          onDone={() => {
            setApproveUser(null);
            queryClient.invalidateQueries({ queryKey: ["admin-users"] });
          }}
        />
      )}

      {rejectUser && (
        <RejectUserDialog
          user={rejectUser}
          onClose={() => setRejectUser(null)}
          onDone={() => {
            setRejectUser(null);
            queryClient.invalidateQueries({ queryKey: ["admin-users"] });
          }}
        />
      )}
    </div>
  );
}

// ─── Approve dialog ──────────────────────────────────────────
function ApproveUserDialog({
  user,
  clients,
  callerRole,
  onClose,
  onDone,
}: {
  user: AdminUser;
  clients: { id: string; company_name: string }[];
  callerRole: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const suggestedRole = user.role ?? (user.email?.endsWith("@nobraineragency.com") ? "user" : "view_only");
  const [role, setRole] = useState(suggestedRole);
  const [selectedClients, setSelectedClients] = useState<Set<string>>(new Set(user.client_ids));
  const [submitting, setSubmitting] = useState(false);

  const availableRoles = callerRole === "super_admin" ? ROLES : ROLES.filter((r) => r.value === "user" || r.value === "view_only");

  const submit = async () => {
    setSubmitting(true);
    try {
      await decideAdminUserApproval(user.id, {
        decision: "approve",
        role,
        clientIds: Array.from(selectedClients),
      });
      toast({ title: "User approved", description: `${user.email} can now sign in.` });
      onDone();
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Approval failed.",
        variant: "destructive",
      });
    }
    setSubmitting(false);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Approve {user.email}</DialogTitle>
          <DialogDescription>Set their role and (optionally) grant client access.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Role</Label>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {availableRoles.map((r) => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Client access (optional)</Label>
            <div className="max-h-48 overflow-auto border rounded-lg p-2 space-y-1.5">
              {clients.map((c) => (
                <div key={c.id} className="flex items-center gap-2">
                  <Checkbox
                    id={`ap-c-${c.id}`}
                    checked={selectedClients.has(c.id)}
                    onCheckedChange={(checked) => {
                      const next = new Set(selectedClients);
                      if (checked) next.add(c.id); else next.delete(c.id);
                      setSelectedClients(next);
                    }}
                  />
                  <Label htmlFor={`ap-c-${c.id}`} className="font-normal cursor-pointer">{c.company_name}</Label>
                </div>
              ))}
              {!clients.length && <p className="text-xs text-muted-foreground">No clients yet.</p>}
            </div>
            <p className="text-xs text-muted-foreground">View-only users can ONLY see clients you grant access to.</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={submitting}>
            {submitting ? "Approving…" : "Approve user"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Reject dialog ───────────────────────────────────────────
function RejectUserDialog({
  user,
  onClose,
  onDone,
}: {
  user: AdminUser;
  onClose: () => void;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    setSubmitting(true);
    try {
      await decideAdminUserApproval(user.id, {
        decision: "reject",
        rejectionReason: reason.trim() || null,
      });
      toast({ title: "User rejected" });
      onDone();
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Rejection failed.",
        variant: "destructive",
      });
    }
    setSubmitting(false);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Reject {user.email}?</DialogTitle>
          <DialogDescription>They'll see this reason when they next sign in.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label>Reason (optional)</Label>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={4} placeholder="Not a verified user, unknown email, etc." />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" onClick={submit} disabled={submitting}>
            {submitting ? "Rejecting…" : "Reject user"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Invite dialog ───────────────────────────────────────────
function InviteUserDialog({
  open,
  onOpenChange,
  clients,
  callerRole,
  onInvited,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  clients: { id: string; company_name: string }[];
  callerRole: string | null;
  onInvited: () => void;
}) {
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState("user");
  const [selectedClients, setSelectedClients] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  const availableRoles = callerRole === "super_admin" ? ROLES : ROLES.filter((r) => r.value === "user" || r.value === "view_only");

  const submit = async () => {
    setSubmitting(true);
    try {
      await inviteAdminUser({
        email: email.trim(),
        fullName: toDisplayName(fullName),
        role,
        clientIds: Array.from(selectedClients),
      });
      toast({ title: "User invited", description: `Invitation email sent to ${email}.` });
      setEmail(""); setFullName(""); setRole("user"); setSelectedClients(new Set());
      onOpenChange(false);
      onInvited();
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button><Plus className="h-4 w-4 mr-1" /> Invite user</Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Invite a new user</DialogTitle>
          <DialogDescription>They'll receive an email to set their password and are auto-approved.</DialogDescription>
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
          <div className="space-y-2">
            <Label>Role</Label>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {availableRoles.map((r) => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Client access (optional)</Label>
            <div className="max-h-48 overflow-auto border rounded-lg p-2 space-y-1.5">
              {clients.map((c) => (
                <div key={c.id} className="flex items-center gap-2">
                  <Checkbox
                    id={`inv-c-${c.id}`}
                    checked={selectedClients.has(c.id)}
                    onCheckedChange={(checked) => {
                      const next = new Set(selectedClients);
                      if (checked) next.add(c.id); else next.delete(c.id);
                      setSelectedClients(next);
                    }}
                  />
                  <Label htmlFor={`inv-c-${c.id}`} className="font-normal cursor-pointer">{c.company_name}</Label>
                </div>
              ))}
              {!clients.length && <p className="text-xs text-muted-foreground">No clients yet.</p>}
            </div>
            <p className="text-xs text-muted-foreground">View-only users can ONLY see clients you grant access to. Other roles see all clients.</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={submitting || !email.trim()}>{submitting ? "Inviting…" : "Send invite"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Client access dialog ────────────────────────────────────
function ClientAccessDialog({
  user,
  clients,
  onClose,
  onSaved,
}: {
  user: AdminUser;
  clients: { id: string; company_name: string }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [selected, setSelected] = useState<Set<string>>(new Set(user.client_ids));
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await replaceAdminUserClientAccess(user.id, Array.from(selected));
      toast({ title: "Client access updated" });
      onSaved();
    } catch (error) {
      toast({
        title: "Error",
        description:
          error instanceof Error ? error.message : "Client access update failed.",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Client access — {user.email}</DialogTitle>
          <DialogDescription>
            <Shield className="inline h-3.5 w-3.5 mr-1" />
            View-only users only see selected clients. Other roles see all.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[50vh] overflow-auto border rounded-lg p-2 space-y-1.5">
          {clients.map((c) => (
            <div key={c.id} className="flex items-center gap-2">
              <Checkbox
                id={`ca-${c.id}`}
                checked={selected.has(c.id)}
                onCheckedChange={(checked) => {
                  const next = new Set(selected);
                  if (checked) next.add(c.id); else next.delete(c.id);
                  setSelected(next);
                }}
              />
              <Label htmlFor={`ca-${c.id}`} className="font-normal cursor-pointer">{c.company_name}</Label>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
