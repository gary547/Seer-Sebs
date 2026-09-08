import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);

describe("provider migration release script", () => {
  it.each([
    { automatic: "false", secretState: "ENABLED", succeeds: true, deploys: false },
    { automatic: "true", secretState: "DISABLED", succeeds: false, deploys: false },
    { automatic: "true", secretState: "ENABLED", succeeds: true, deploys: true },
  ])("runs safely with controlled cloud commands: %j", async ({ automatic, secretState, succeeds, deploys }) => {
    const directory = await mkdtemp(join(tmpdir(), "seer-release-provider-"));
    const build = await readFile("gcp/cloudbuild.runtime.yaml", "utf8");
    const step = build.slice(build.indexOf("  - id: deploy-runtime"), build.indexOf("  - id: deploy-web"));
    const body = step.split("    script: |\n")[1]!.split("    waitFor:")[0]!
      .split("\n").map(line => line.replace(/^      /, "")).join("\n");
    const scriptPath = join(directory, "release.sh");
    const logPath = join(directory, "calls.jsonl");
    const environmentPath = join(directory, "image.env");
    await writeFile(environmentPath, "SEER_RELEASE_IMAGE=example.invalid/runtime@sha256:test\nSEER_RELEASE_DATABASE_IMAGE=example.invalid/database@sha256:test\n");
    await writeFile(scriptPath, body.replace("/workspace/release/image.env", environmentPath));
    await writeFile(logPath, "");
    const stub = `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(process.env.SEER_STUB_LOG,JSON.stringify(process.argv.slice(2))+'\\n');if(process.argv[2]==='secrets')process.stdout.write(process.env.SEER_STUB_SECRET_STATE+'\\n');\n`;
    await writeFile(join(directory, "gcloud"), stub);
    await writeFile(join(directory, "curl"), "#!/bin/sh\nexit 0\n");
    await chmod(join(directory, "gcloud"), 0o700);
    await chmod(join(directory, "curl"), 0o700);
    let failed = false;
    let failure: unknown;
    try {
      await execute("/bin/bash", [scriptPath], { timeout: 10_000, env: {
        PATH: `${directory}:/usr/bin:/bin`, CLOUDSDK_CONFIG: join(directory, "isolated-cloud"),
        _AUTO_DEPLOY: automatic, PROJECT_ID: "secure-cipher-503913-f1", _REGION: "europe-west2",
        _SEER_API_URL: "https://api.example.invalid", SEER_STUB_LOG: logPath, SEER_STUB_SECRET_STATE: secretState,
      } });
    } catch (error) { failed = true; failure = error; }
    expect(failed, String(failure)).toBe(!succeeds);
    const calls = (await readFile(logPath, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as string[]);
    if (!deploys) {
      expect(calls.every(args => args[0] === "secrets")).toBe(true);
      expect(calls).toHaveLength(automatic === "true" ? 1 : 0);
      return;
    }
    const services = calls.filter(args => args.slice(0, 3).join(" ") === "run services update");
    expect(services).toHaveLength(3);
    const worker = services.find(args => args[3] === "seer-worker")!;
    expect(worker).toContain("--update-secrets=OPENROUTER_API_KEY=seer-openrouter-api-key:latest");
    expect(worker).toContain("--remove-secrets=AHREFS_API_KEY,ANTHROPIC_API_KEY");
    expect(services.filter(args => args[3] !== "seer-worker").every(args => !args.some(arg => arg.includes("secrets=")))).toBe(true);
    expect(calls[0]!.slice(0, 3)).toEqual(["secrets", "versions", "describe"]);
  }, 15_000);
});
