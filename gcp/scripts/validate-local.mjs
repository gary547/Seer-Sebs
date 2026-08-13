import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";

const apiBaseUrl = process.env.SEER_LOCAL_API_URL ?? "http://127.0.0.1:18080";
const dispatcherBaseUrl =
  process.env.SEER_LOCAL_DISPATCHER_URL ?? "http://127.0.0.1:18083";
const eventsBaseUrl =
  process.env.SEER_LOCAL_EVENTS_URL ?? "http://127.0.0.1:18084";
const objectStoreBaseUrl =
  process.env.SEER_LOCAL_OBJECT_STORE_URL ?? "http://127.0.0.1:18081";
const workerBaseUrl = process.env.SEER_LOCAL_WORKER_URL ?? "http://127.0.0.1:18082";
const statePath =
  process.env.SEER_LOCAL_VALIDATION_STATE ??
  "/private/tmp/seer-gcp-local-validation-state.json";

async function jsonRequest(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  let body;

  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${url} returned non-JSON content with status ${response.status}.`);
  }

  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}: ${JSON.stringify(body)}`);
  }

  return body;
}

function authenticated(token, init = {}) {
  return {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...init.headers,
    },
  };
}

async function assertRuntimeReady() {
  const services = await Promise.all(
    [
      apiBaseUrl,
      dispatcherBaseUrl,
      eventsBaseUrl,
      objectStoreBaseUrl,
      workerBaseUrl,
    ].map((baseUrl) => jsonRequest(`${baseUrl}/readyz`)),
  );

  if (!services.every((service) => service.status === "ready")) {
    throw new Error(`Runtime is not ready: ${JSON.stringify(services)}`);
  }

  return services.length;
}

function assertPersistedRun(run) {
  if (run.status !== "succeeded") {
    throw new Error(`Pipeline run status is ${run.status}.`);
  }
  if (!Array.isArray(run.stages) || run.stages.length !== 24) {
    throw new Error(`Expected 24 stages, received ${run.stages?.length ?? "none"}.`);
  }
  if (!run.stages.every((stage) => stage.state === "succeeded")) {
    throw new Error("At least one pipeline stage did not succeed.");
  }
  if (!run.stages.every((stage) => stage.attempts === 1)) {
    throw new Error("At least one pipeline stage was executed more than once.");
  }
  if (run.deliveredEventCount !== 24) {
    throw new Error(`Expected 24 delivered events, received ${run.deliveredEventCount}.`);
  }
}

async function validatePersistence() {
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const serviceCount = await assertRuntimeReady();
  const asset = await jsonRequest(
    `${apiBaseUrl}/v1/assets/${state.assetId}`,
    authenticated(state.token),
  );
  const run = await jsonRequest(
    `${apiBaseUrl}/v1/pipeline-runs/${state.runId}`,
    authenticated(state.token),
  );

  if (asset.contentBase64 !== state.contentBase64) {
    throw new Error("Object content did not survive the restart.");
  }
  assertPersistedRun(run);

  console.log(
    JSON.stringify({
      assetPersisted: true,
      databasePersisted: true,
      deliveredEvents: run.deliveredEventCount,
      mode: "persistence",
      servicesReady: serviceCount,
      stagesSucceeded: run.stages.length,
    }),
  );
}

async function validateEndToEnd() {
  const serviceCount = await assertRuntimeReady();
  const email = `validation-${Date.now()}@example.dev`;
  const password = "Local-validation-2026";
  const registration = await jsonRequest(`${apiBaseUrl}/v1/local-auth/register`, {
    body: JSON.stringify({ email, password }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const login = await jsonRequest(`${apiBaseUrl}/v1/local-auth/login`, {
    body: JSON.stringify({ email, password }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

  if (registration.user.id !== login.user.id || typeof login.token !== "string") {
    throw new Error("Local identity registration and login are inconsistent.");
  }

  const contentBase64 = Buffer.from(
    `seer-gcp-object-persistence:${registration.user.id}`,
  ).toString("base64");
  const asset = await jsonRequest(
    `${apiBaseUrl}/v1/assets`,
    authenticated(login.token, {
      body: JSON.stringify({
        contentBase64,
        contentType: "text/plain",
        fileName: "validation.txt",
      }),
      method: "POST",
    }),
  );
  const storedAsset = await jsonRequest(
    `${apiBaseUrl}/v1/assets/${asset.id}`,
    authenticated(login.token),
  );

  if (storedAsset.contentBase64 !== contentBase64) {
    throw new Error("Object storage returned different content.");
  }

  const createdRun = await jsonRequest(
    `${apiBaseUrl}/v1/pipeline-runs`,
    authenticated(login.token, {
      body: JSON.stringify({
        assetId: asset.id,
        purpose: "docker-structure-validation",
      }),
      method: "POST",
    }),
  );
  const deadline = Date.now() + 30_000;
  let run;

  while (Date.now() < deadline) {
    run = await jsonRequest(
      `${apiBaseUrl}/v1/pipeline-runs/${createdRun.id}`,
      authenticated(login.token),
    );

    if (run.status === "succeeded" && run.deliveredEventCount === 24) {
      break;
    }
    if (run.status === "failed") {
      throw new Error(`Pipeline failed: ${JSON.stringify(run)}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  if (!run) {
    throw new Error("Pipeline status was not returned.");
  }
  assertPersistedRun(run);

  const retry = await jsonRequest(
    `${workerBaseUrl}/internal/tasks`,
    authenticated("seer-local-internal-token", {
      body: JSON.stringify({
        runId: createdRun.id,
        stageId: "intake",
        taskId: "validation-redelivery",
      }),
      method: "POST",
    }),
  );

  if (retry.idempotent !== true) {
    throw new Error("Worker redelivery was not idempotent.");
  }

  await writeFile(
    statePath,
    JSON.stringify(
      {
        assetId: asset.id,
        contentBase64,
        runId: createdRun.id,
        token: login.token,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );

  console.log(
    JSON.stringify({
      assetRoundTrip: true,
      deliveredEvents: run.deliveredEventCount,
      identityRoundTrip: true,
      mode: "end-to-end",
      servicesReady: serviceCount,
      stagesSucceeded: run.stages.length,
      workerRedeliveryIdempotent: true,
    }),
  );
}

if (process.argv.includes("--persistence")) {
  await validatePersistence();
} else {
  await validateEndToEnd();
}
