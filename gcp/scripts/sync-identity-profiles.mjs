import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import pg from "pg";

const { Client } = pg;

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1]
    ? process.argv[index + 1]
    : fallback;
}

function requiredArgument(name) {
  const value = argument(name);
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function normaliseUsers(value) {
  if (!value || !Array.isArray(value.users)) {
    throw new Error("The Identity Platform export must contain a users array.");
  }
  const users = value.users.map((user, index) => {
    if (
      !user ||
      typeof user.localId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        user.localId,
      ) ||
      typeof user.email !== "string" ||
      !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(user.email)
    ) {
      throw new Error(`Identity user ${index} has an invalid UID or email.`);
    }
    return {
      disabled: user.disabled === true,
      email: user.email.trim().toLowerCase(),
      emailVerified: user.emailVerified === true,
      userId: user.localId.toLowerCase(),
    };
  });
  if (new Set(users.map((user) => user.userId)).size !== users.length) {
    throw new Error("The Identity Platform export contains duplicate UIDs.");
  }
  if (new Set(users.map((user) => user.email)).size !== users.length) {
    throw new Error("The Identity Platform export contains duplicate emails.");
  }
  return users;
}

function compare(users, profiles) {
  const usersById = new Map(users.map((user) => [user.userId, user]));
  const profilesById = new Map(
    profiles.map((profile) => [String(profile.user_id).toLowerCase(), profile]),
  );
  const missingProfiles = users.filter(
    (user) => !profilesById.has(user.userId),
  );
  const mismatchedProfiles = users.filter((user) => {
    const profile = profilesById.get(user.userId);
    return (
      profile &&
      (String(profile.email).toLowerCase() !== user.email ||
        profile.identity_provider !== "identity-platform" ||
        profile.identity_email_verified !== user.emailVerified)
    );
  });
  const orphanProfiles = profiles.filter(
    (profile) =>
      profile.identity_provider !== "local" &&
      !usersById.has(String(profile.user_id).toLowerCase()),
  );
  return {
    mismatchedProfiles,
    missingProfiles,
    orphanProfiles,
  };
}

const identityPath = resolve(requiredArgument("--identity"));
const outputArgument = argument("--output");
const outputPath = outputArgument ? resolve(outputArgument) : null;
const apply = process.argv.includes("--apply");
const identity = JSON.parse(await readFile(identityPath, "utf8"));
const users = normaliseUsers(identity);
const client = new Client({
  connectionString: requiredEnvironment("SEER_TARGET_DATABASE_URL"),
  statement_timeout: 120_000,
});

await client.connect();
try {
  const beforeRows = await client.query(`
    SELECT
      user_id,
      email,
      identity_provider,
      identity_email_verified
    FROM profiles
    ORDER BY user_id
  `);
  const before = compare(users, beforeRows.rows);
  if (apply) {
    await client.query("BEGIN");
    try {
      for (const user of users) {
        await client.query(
          `
            INSERT INTO profiles (
              user_id,
              email,
              identity_provider,
              identity_email_verified,
              approval_status
            )
            VALUES ($1, $2, 'identity-platform', $3, 'pending')
            ON CONFLICT (user_id)
            DO UPDATE SET
              email = EXCLUDED.email,
              identity_provider = EXCLUDED.identity_provider,
              identity_email_verified = EXCLUDED.identity_email_verified
          `,
          [user.userId, user.email, user.emailVerified],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }

  const afterRows = apply
    ? await client.query(`
        SELECT
          user_id,
          email,
          identity_provider,
          identity_email_verified
        FROM profiles
        ORDER BY user_id
      `)
    : beforeRows;
  const after = compare(users, afterRows.rows);
  const report = {
    apply,
    disabledUsers: users.filter((user) => user.disabled).length,
    identityUsers: users.length,
    mismatchedAfter: after.mismatchedProfiles.length,
    missingAfter: after.missingProfiles.length,
    orphanProfiles: after.orphanProfiles.map((profile) =>
      String(profile.user_id),
    ),
    plannedInserts: before.missingProfiles.length,
    plannedUpdates: before.mismatchedProfiles.length,
    passed:
      apply &&
      after.missingProfiles.length === 0 &&
      after.mismatchedProfiles.length === 0 &&
      after.orphanProfiles.length === 0,
  };
  if (outputPath) {
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, {
      mode: 0o600,
    });
  }
  console.log(JSON.stringify({ ...report, outputPath }));
  if (apply && !report.passed) process.exitCode = 1;
} finally {
  await client.end();
}
