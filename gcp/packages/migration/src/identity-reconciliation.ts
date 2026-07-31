export interface IdentityExportUser {
  disabled?: boolean;
  email?: string;
  emailVerified?: boolean;
  localId: string;
}

function indexed(
  users: readonly IdentityExportUser[],
  label: string,
): Map<string, IdentityExportUser> {
  const result = new Map<string, IdentityExportUser>();
  const emails = new Set<string>();
  for (const user of users) {
    if (!user.localId || result.has(user.localId)) {
      throw new Error(`${label} contains a duplicate or empty UID.`);
    }
    result.set(user.localId, user);
    if (user.email) {
      const email = user.email.trim().toLowerCase();
      if (emails.has(email)) throw new Error(`${label} contains a duplicate email.`);
      emails.add(email);
    }
  }
  return result;
}

export function reconcileIdentityUsers(
  sourceUsers: readonly IdentityExportUser[],
  targetUsers: readonly IdentityExportUser[],
): {
  disabledMismatches: string[];
  emailMismatches: string[];
  emailVerifiedMismatches: string[];
  extraTargetUids: string[];
  matchedUsers: number;
  missingTargetUids: string[];
  passed: boolean;
  sourceUsers: number;
  targetUsers: number;
} {
  const source = indexed(sourceUsers, "Source identity export");
  const target = indexed(targetUsers, "Target identity export");
  const missingTargetUids: string[] = [];
  const extraTargetUids: string[] = [];
  const disabledMismatches: string[] = [];
  const emailMismatches: string[] = [];
  const emailVerifiedMismatches: string[] = [];
  let matchedUsers = 0;

  for (const [uid, sourceUser] of source) {
    const targetUser = target.get(uid);
    if (!targetUser) {
      missingTargetUids.push(uid);
      continue;
    }
    matchedUsers += 1;
    if (
      (sourceUser.email ?? "").trim().toLowerCase() !==
      (targetUser.email ?? "").trim().toLowerCase()
    ) {
      emailMismatches.push(uid);
    }
    if (
      Boolean(sourceUser.emailVerified) !== Boolean(targetUser.emailVerified)
    ) {
      emailVerifiedMismatches.push(uid);
    }
    if (Boolean(sourceUser.disabled) !== Boolean(targetUser.disabled)) {
      disabledMismatches.push(uid);
    }
  }
  for (const uid of target.keys()) {
    if (!source.has(uid)) extraTargetUids.push(uid);
  }
  const passed =
    disabledMismatches.length === 0 &&
    missingTargetUids.length === 0 &&
    extraTargetUids.length === 0 &&
    emailMismatches.length === 0 &&
    emailVerifiedMismatches.length === 0;
  return {
    disabledMismatches,
    emailMismatches,
    emailVerifiedMismatches,
    extraTargetUids,
    matchedUsers,
    missingTargetUids,
    passed,
    sourceUsers: source.size,
    targetUsers: target.size,
  };
}
