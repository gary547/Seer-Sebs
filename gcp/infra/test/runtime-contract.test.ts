import { execFile } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();
const execFileAsync = promisify(execFile);

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

  it("lets the Cloud Build service agent manage connection secrets", async () => {
    const main = await read("gcp/infra/main.tf");

    expect(main).toContain(
      'resource "google_project_iam_member" "cloud_build_connection_secret_admin"',
    );
    expect(main).toContain('role    = "roles/secretmanager.admin"');
    expect(main).toContain('"roles/firebasehosting.admin"');
    expect(main).toContain('"roles/serviceusage.serviceUsageConsumer"');
    expect(main).toContain(
      "service-${data.google_project.current.number}@gcp-sa-cloudbuild.iam.gserviceaccount.com",
    );
  });

  it("isolates manual build uploads in a short-lived read-only source bucket", async () => {
    const main = await read("gcp/infra/main.tf");

    expect(main).toContain(
      'resource "google_storage_bucket" "build_source"',
    );
    expect(main).toContain(
      'name                        = "${var.project_id}-${var.name_prefix}-build-source"',
    );
    expect(main).toMatch(
      /resource "google_storage_bucket_iam_member" "build_source"[\s\S]*role\s+= "roles\/storage\.objectViewer"/,
    );
    expect(main).toMatch(
      /resource "google_storage_bucket" "build_source"[\s\S]*age = 7/,
    );
  });

  it("installs both locked dependency trees before validating the GCP runtime", async () => {
    const runtimeBuild = await read("gcp/cloudbuild.runtime.yaml");

    expect(runtimeBuild).toContain(
      "npm ci --ignore-scripts --fund=false --audit=false",
    );
    expect(runtimeBuild).toContain(
      "npm ci --prefix gcp --ignore-scripts --fund=false --audit=false",
    );
  });

  it("uses API-valid executable scripts in both Cloud Build pipelines", async () => {
    const builds = await Promise.all([
      read("gcp/cloudbuild.runtime.yaml"),
      read("gcp/cloudbuild.web.yaml"),
    ]);

    for (const build of builds) {
      const scriptedSteps = build
        .split(/\n(?=  - id: )/)
        .filter((step) => step.includes("\n    script: |"));

      expect(scriptedSteps.length).toBeGreaterThan(0);
      for (const step of scriptedSteps) {
        expect(step).not.toContain("\n    entrypoint:");
        expect(step).toContain("\n    script: |\n      #!/usr/bin/env bash");
      }
    }
  });

  it("uploads only deployable source and targets the managed Firebase site", async () => {
    const [cloudIgnore, firebaseConfig, hostingScript, webBuild] =
      await Promise.all([
        read(".gcloudignore"),
        read("firebase.json"),
        read("gcp/scripts/deploy-firebase-hosting.sh"),
        read("gcp/cloudbuild.web.yaml"),
      ]);

    expect(cloudIgnore).toContain("gcp/infra/.terraform/**");
    expect(cloudIgnore).toContain("migration-evidence/**");
    expect(cloudIgnore).toContain("**/.env.*");
    expect(firebaseConfig).toContain('"target": "web"');
    expect(hostingScript).toContain(
      'firebase target:apply hosting "${target}" "${site_id}"',
    );
    expect(hostingScript).toContain('--only "hosting:${target}"');
    expect(hostingScript).toContain('--only "${target}"');
    expect(webBuild).toContain(
      "SEER_FIREBASE_SITE_ID=${_FIREBASE_SITE_ID}",
    );
  });

  it.each([
    {
      channel: "live",
      expectedDeploy:
        "deploy --project secure-cipher-503913-f1 --only hosting:web --non-interactive",
    },
    {
      channel: "review-42",
      expectedDeploy:
        "hosting:channel:deploy review-42 --project secure-cipher-503913-f1 --only web --expires 7d --non-interactive",
    },
  ])("runs the Firebase $channel deployment against the web target", async ({
    channel,
    expectedDeploy,
  }) => {
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "seer-firebase-deploy-"),
    );
    const firebaseExecutable = join(temporaryDirectory, "firebase");
    const callLog = join(temporaryDirectory, "calls.log");

    try {
      await writeFile(
        firebaseExecutable,
        '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >> "${FIREBASE_CALL_LOG}"\n',
      );
      await chmod(firebaseExecutable, 0o755);

      await execFileAsync("bash", ["gcp/scripts/deploy-firebase-hosting.sh"], {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          BUILD_ID: "test-build",
          FIREBASE_CALL_LOG: callLog,
          PATH: `${temporaryDirectory}:${process.env.PATH ?? ""}`,
          SEER_FIREBASE_CHANNEL: channel,
          SEER_FIREBASE_PROJECT_ID: "secure-cipher-503913-f1",
          SEER_FIREBASE_SITE_ID: "seer-161062363690",
        },
      });

      const calls = await readFile(callLog, "utf8");
      expect(calls).toContain(
        "target:apply hosting web seer-161062363690 --project secure-cipher-503913-f1 --non-interactive",
      );
      expect(calls).toContain(expectedDeploy);
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
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
    const [bootstrap, migrationJob, runtime, variables] = await Promise.all([
      read("gcp/database/bootstrap/apply-target-schema.sh"),
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
    expect(bootstrap).toContain("SELECT role_name, grantee");
    expect(bootstrap).toContain("ORDER BY role_name, grantee");
    expect(bootstrap).not.toContain("SELECT role_name, member");
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
