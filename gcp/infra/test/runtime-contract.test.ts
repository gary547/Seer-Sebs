import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();

async function read(path: string): Promise<string> {
  return readFile(`${repositoryRoot}/${path}`, "utf8");
}

describe("managed database runtime contract", () => {
  it("uses automatic IAM database authentication without password URL secrets", async () => {
    const [main, runtime] = await Promise.all([
      read("gcp/infra/main.tf"),
      read("gcp/infra/runtime.tf"),
    ]);

    expect(main).toContain('"roles/cloudsql.instanceUser"');
    expect(main).toContain('type            = "CLOUD_IAM_SERVICE_ACCOUNT"');
    expect(main).not.toContain("seer-api-database-url");
    expect(main).not.toContain("seer-worker-database-url");
    expect(runtime).toContain('"--auto-iam-authn"');
    expect(runtime).toContain('depends_on = ["cloud-sql-proxy"]');
    expect(runtime).toContain("@127.0.0.1:5432/seer");
    expect(runtime).not.toContain("seer-api-database-url");
    expect(runtime).not.toContain("seer-worker-database-url");
  });

  it("uses an Enterprise-compatible custom tier and an explicit provider quota project", async () => {
    const [main, providers] = await Promise.all([
      read("gcp/infra/main.tf"),
      read("gcp/infra/versions.tf"),
    ]);

    expect(main).toContain('edition           = "ENTERPRISE"');
    expect(main).toContain("tier              = var.database_tier");
    expect(providers.match(/billing_project\s+= var\.project_id/g)).toHaveLength(2);
    expect(providers.match(/user_project_override\s+= true/g)).toHaveLength(2);
  });

  it("authorizes the Firebase web app auth domain alongside the hosting domains", async () => {
    const main = await read("gcp/infra/main.tf");

    expect(main).toContain(
      "data.google_firebase_web_app_config.web.auth_domain",
    );
    expect(main).toContain(
      '"${coalesce(var.firebase_site_id, var.project_id)}.web.app"',
    );
    expect(main).toContain(
      '"${coalesce(var.firebase_site_id, var.project_id)}.firebaseapp.com"',
    );
    expect(main).toMatch(/phone_number\s*\{\s*enabled\s*= false\s*\}/);
  });

  it("pins the proxy and gates runtime deployment on schema evidence", async () => {
    const [migrationJob, runtime, variables] = await Promise.all([
      read("gcp/infra/database-migration.tf"),
      read("gcp/infra/runtime.tf"),
      read("gcp/infra/variables.tf"),
    ]);

    expect(variables).toMatch(
      /cloud-sql-proxy@sha256:[0-9a-f]{64}/,
    );
    expect(migrationJob).toContain(
      'service_account = google_service_account.runtime["migrator"].email',
    );
    expect(migrationJob).toContain("max_retries     = 0");
    expect(runtime).toContain("condition     = var.database_schema_ready");
  });

  it("schedules leased URL checks and retention through a private workflow", async () => {
    const [main, maintenance, monitor] = await Promise.all([
      read("gcp/infra/main.tf"),
      read("gcp/workflows/maintenance.yaml.tftpl"),
      read("gcp/apps/api/src/url-monitor.ts"),
    ]);

    expect(main).toContain(
      'resource "google_cloud_scheduler_job" "maintenance"',
    );
    expect(main).toContain('"roles/workflows.invoker"');
    expect(main).toContain('"*/5 * * * *"');
    expect(main).toContain('"15 3 * * *"');
    expect(maintenance).toContain("X-Seer-Internal-Token");
    expect(maintenance).toContain('type: OIDC');
    expect(monitor).toContain("FOR UPDATE OF monitored_url SKIP LOCKED");
    expect(monitor).toContain("lease_expires_at");
  });
});
