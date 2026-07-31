import { mkdir, writeFile } from "node:fs/promises";
import process from "node:process";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

const image = required("SEER_RELEASE_IMAGE");
const databaseImage = required("SEER_RELEASE_DATABASE_IMAGE");
const databaseTransferImage = required("SEER_RELEASE_DATABASE_TRANSFER_IMAGE");
const outputDirectory = required("SEER_RELEASE_OUTPUT_DIRECTORY");
const imagePattern =
  /^(?<repository>[a-z0-9-]+-docker\.pkg\.dev\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/[a-z][a-z0-9-]{1,62}\/[a-z][a-z0-9._-]{0,127})@(?<digest>sha256:[0-9a-f]{64})$/;
const match = image.match(imagePattern);
const databaseMatch = databaseImage.match(imagePattern);
const databaseTransferMatch = databaseTransferImage.match(imagePattern);
if (!match?.groups) {
  throw new Error("SEER_RELEASE_IMAGE must be an immutable Artifact Registry digest.");
}
if (!databaseMatch?.groups) {
  throw new Error(
    "SEER_RELEASE_DATABASE_IMAGE must be an immutable Artifact Registry digest.",
  );
}
if (!databaseTransferMatch?.groups) {
  throw new Error(
    "SEER_RELEASE_DATABASE_TRANSFER_IMAGE must be an immutable Artifact Registry digest.",
  );
}

const buildId = required("SEER_RELEASE_BUILD_ID");
const commitSha = required("SEER_RELEASE_COMMIT_SHA");
if (!/^[0-9a-f]{40}$/.test(commitSha)) {
  throw new Error("SEER_RELEASE_COMMIT_SHA must be a full Git commit SHA.");
}

const createdAt = new Date().toISOString();
const manifest = {
  buildId,
  commitSha,
  createdAt,
  databaseImage,
  databaseImageDigest: databaseMatch.groups.digest,
  databaseTransferImage,
  databaseTransferImageDigest: databaseTransferMatch.groups.digest,
  image,
  imageDigest: match.groups.digest,
  imageRepository: match.groups.repository,
  modelVersions: {
    calibration: "calibration_v1.0.0",
    har: "har_v2.1.0",
    revenue: "revenue_v2.1.0",
  },
  pipelineStageCount: 19,
};
const runtimeImages = {
  database_migration_image: databaseImage,
  database_transfer_image: databaseTransferImage,
  runtime_images: {
    api: image,
    dispatcher: image,
    events: image,
    worker: image,
  },
};

await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  writeFile(
    `${outputDirectory}/release-manifest.json`,
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 },
  ),
  writeFile(
    `${outputDirectory}/runtime-images.auto.tfvars.json`,
    `${JSON.stringify(runtimeImages, null, 2)}\n`,
    { mode: 0o600 },
  ),
]);

console.log(JSON.stringify(manifest));
