import { getAccessToken } from "./auth";
import { seerApiRequest } from "./api";

export interface TargetAdminUser {
  approval_status: "pending" | "approved" | "rejected";
  approved_at: string | null;
  approved_by: string | null;
  client_ids: string[];
  created_at: string;
  email: string | null;
  full_name: string | null;
  id: string;
  last_sign_in_at: string | null;
  rejection_reason: string | null;
  role: string | null;
}

async function authenticatedRequest<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = await getAccessToken();
  if (!token) throw new Error("Authentication is required.");
  return seerApiRequest<T>(path, options, token);
}

export async function listAdminUsers(): Promise<TargetAdminUser[]> {
  const result = await authenticatedRequest<{ users: TargetAdminUser[] }>(
    "/v1/admin/users",
  );
  return result.users;
}

export async function inviteAdminUser(input: {
  clientIds: string[];
  email: string;
  fullName: string;
  role: string;
}): Promise<void> {
  await authenticatedRequest("/v1/admin/users/invitations", {
    body: JSON.stringify(input),
    method: "POST",
  });
}

export async function setAdminUserRole(userId: string, role: string): Promise<void> {
  await authenticatedRequest(`/v1/admin/users/${userId}/role`, {
    body: JSON.stringify({ role }),
    method: "PATCH",
  });
}

export async function decideAdminUserApproval(
  userId: string,
  input: {
    clientIds?: string[];
    decision: "approve" | "reject";
    rejectionReason?: string | null;
    role?: string;
  },
): Promise<void> {
  await authenticatedRequest(`/v1/admin/users/${userId}/approval`, {
    body: JSON.stringify(input),
    method: "PATCH",
  });
}

export async function deleteAdminUser(userId: string): Promise<void> {
  await authenticatedRequest(`/v1/admin/users/${userId}`, {
    method: "DELETE",
  });
}

export async function replaceAdminUserClientAccess(
  userId: string,
  clientIds: string[],
): Promise<void> {
  await authenticatedRequest(`/v1/admin/users/${userId}/client-access`, {
    body: JSON.stringify({ clientIds }),
    method: "PUT",
  });
}
