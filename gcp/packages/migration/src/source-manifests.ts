import { createHash } from "node:crypto";

export interface SourceAuthIdentity {
  identityData: Record<string, unknown> | null;
  provider: string | null;
  providerId: string | null;
  userId: string;
}

export interface SourceAuthUser {
  bannedUntil: string | null;
  createdAt: string | null;
  email: string | null;
  emailConfirmedAt: string | null;
  encryptedPassword: string | null;
  id: string;
  lastSignInAt: string | null;
  rawUserMetadata: Record<string, unknown> | null;
}

interface FirebaseProvider {
  displayName?: string;
  email?: string;
  photoUrl?: string;
  providerId: string;
  rawId: string;
}

interface FirebaseUser {
  createdAt?: string;
  disabled?: boolean;
  displayName?: string;
  email?: string;
  emailVerified: boolean;
  lastSignedInAt?: string;
  localId: string;
  passwordHash?: string;
  photoUrl?: string;
  providerUserInfo?: FirebaseProvider[];
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function timestampMilliseconds(value: string | null): string | undefined {
  if (!value) return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? String(milliseconds) : undefined;
}

function providerName(value: string | null): string | null {
  switch (value?.toLowerCase()) {
    case "google":
    case "google.com":
      return "google.com";
    case "github":
    case "github.com":
      return "github.com";
    case "facebook":
    case "facebook.com":
      return "facebook.com";
    case "twitter":
    case "twitter.com":
      return "twitter.com";
    default:
      return null;
  }
}

function providerRecord(identity: SourceAuthIdentity): FirebaseProvider | null {
  const providerId = providerName(identity.provider);
  if (!providerId) return null;
  const data = identity.identityData ?? {};
  const rawId =
    optionalString(identity.providerId) ??
    optionalString(data.sub) ??
    optionalString(data.id);
  if (!rawId) return null;

  const result: FirebaseProvider = { providerId, rawId };
  const email = optionalString(data.email);
  const displayName =
    optionalString(data.full_name) ??
    optionalString(data.name) ??
    optionalString(data.user_name);
  const photoUrl =
    optionalString(data.avatar_url) ?? optionalString(data.picture);
  if (email) result.email = email;
  if (displayName) result.displayName = displayName;
  if (photoUrl) result.photoUrl = photoUrl;
  return result;
}

function userDisplayName(metadata: Record<string, unknown> | null): string | undefined {
  if (!metadata) return undefined;
  return (
    optionalString(metadata.full_name) ??
    optionalString(metadata.name) ??
    optionalString(metadata.display_name)
  );
}

function userPhotoUrl(metadata: Record<string, unknown> | null): string | undefined {
  if (!metadata) return undefined;
  return optionalString(metadata.avatar_url) ?? optionalString(metadata.picture);
}

function emailSignature(email: string | null): string {
  return email
    ? createHash("sha256").update(email.trim().toLowerCase()).digest("hex")
    : "";
}

export function buildIdentityArtifacts(
  users: readonly SourceAuthUser[],
  identities: readonly SourceAuthIdentity[],
  now = Date.now(),
): {
  firebaseImport: { users: FirebaseUser[] };
  reconciliationCsv: string;
  resetRequiredUids: string[];
  summary: Record<string, number>;
} {
  const seenUids = new Set<string>();
  const seenEmails = new Set<string>();
  const identitiesByUser = new Map<string, SourceAuthIdentity[]>();
  for (const identity of identities) {
    const bucket = identitiesByUser.get(identity.userId) ?? [];
    bucket.push(identity);
    identitiesByUser.set(identity.userId, bucket);
  }

  let bcryptUsers = 0;
  let disabledUsers = 0;
  let emailVerifiedUsers = 0;
  let oauthUsers = 0;
  let passwordlessUsers = 0;
  const resetRequiredUids: string[] = [];
  const firebaseUsers: FirebaseUser[] = [];
  const reconciliationRows = [
    "source_uid,target_uid,email_sha256,import_status",
  ];

  for (const user of users) {
    if (!user.id || seenUids.has(user.id)) {
      throw new Error(`Duplicate or empty source UID: ${user.id || "<empty>"}.`);
    }
    seenUids.add(user.id);
    const normalisedEmail = user.email?.trim().toLowerCase() ?? "";
    if (normalisedEmail) {
      if (seenEmails.has(normalisedEmail)) {
        throw new Error(`Duplicate source email detected for UID ${user.id}.`);
      }
      seenEmails.add(normalisedEmail);
    }

    const result: FirebaseUser = {
      emailVerified: Boolean(user.emailConfirmedAt),
      localId: user.id,
    };
    if (user.email) result.email = user.email;
    const createdAt = timestampMilliseconds(user.createdAt);
    const lastSignedInAt = timestampMilliseconds(user.lastSignInAt);
    if (createdAt) result.createdAt = createdAt;
    if (lastSignedInAt) result.lastSignedInAt = lastSignedInAt;
    const displayName = userDisplayName(user.rawUserMetadata);
    const photoUrl = userPhotoUrl(user.rawUserMetadata);
    if (displayName) result.displayName = displayName;
    if (photoUrl) result.photoUrl = photoUrl;

    const password = user.encryptedPassword ?? "";
    if (/^\$2[aby]\$\d{2}\$/.test(password)) {
      result.passwordHash = Buffer.from(password, "utf8").toString("base64");
      bcryptUsers += 1;
    } else if (password) {
      resetRequiredUids.push(user.id);
    } else {
      passwordlessUsers += 1;
    }

    const providers = (identitiesByUser.get(user.id) ?? [])
      .map(providerRecord)
      .filter((provider): provider is FirebaseProvider => provider !== null);
    if (providers.length > 0) {
      result.providerUserInfo = providers;
      oauthUsers += 1;
    }
    if (result.emailVerified) emailVerifiedUsers += 1;
    if (user.bannedUntil && Date.parse(user.bannedUntil) > now) {
      result.disabled = true;
      disabledUsers += 1;
    }

    firebaseUsers.push(result);
    reconciliationRows.push(
      [user.id, user.id, emailSignature(user.email), "pending"].join(","),
    );
  }

  return {
    firebaseImport: { users: firebaseUsers },
    reconciliationCsv: `${reconciliationRows.join("\n")}\n`,
    resetRequiredUids,
    summary: {
      bcryptUsers,
      disabledUsers,
      emailVerifiedUsers,
      oauthUsers,
      passwordlessUsers,
      resetRequiredUsers: resetRequiredUids.length,
      totalUsers: users.length,
    },
  };
}

export interface SourceStorageObject {
  bucketId: string;
  createdAt: string | null;
  id: string;
  metadata: Record<string, unknown> | null;
  name: string;
  owner: string | null;
  updatedAt: string | null;
}

export function buildStorageManifest(
  objects: readonly SourceStorageObject[],
): {
  buckets: Record<string, { objectCount: number; recordedBytes: number }>;
  objects: Array<SourceStorageObject & { recordedBytes: number; sha256: null }>;
} {
  const allowedBuckets = new Set(["client-logos", "slide-exports"]);
  const seen = new Set<string>();
  const buckets: Record<string, { objectCount: number; recordedBytes: number }> = {};
  const output = objects.map((object) => {
    if (!allowedBuckets.has(object.bucketId)) {
      throw new Error(`Unexpected source storage bucket: ${object.bucketId}.`);
    }
    if (!object.name || object.name.startsWith("/") || object.name.includes("\0")) {
      throw new Error(`Invalid source object name in ${object.bucketId}.`);
    }
    const key = `${object.bucketId}/${object.name}`;
    if (seen.has(key)) throw new Error(`Duplicate source object: ${key}.`);
    seen.add(key);
    const metadataSize = object.metadata?.size;
    const recordedBytes =
      typeof metadataSize === "number"
        ? metadataSize
        : typeof metadataSize === "string" && /^\d+$/.test(metadataSize)
          ? Number(metadataSize)
          : 0;
    const bucket = buckets[object.bucketId] ?? {
      objectCount: 0,
      recordedBytes: 0,
    };
    bucket.objectCount += 1;
    bucket.recordedBytes += recordedBytes;
    buckets[object.bucketId] = bucket;
    return { ...object, recordedBytes, sha256: null };
  });

  return { buckets, objects: output };
}
