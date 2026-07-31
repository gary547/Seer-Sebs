import { describe, expect, it } from "vitest";

import {
  buildGcsMultipartUpload,
  sourceObjectUrl,
  sourceStorageHeaders,
  targetBucket,
  targetObjectMatches,
} from "../src/storage-transfer.js";

describe("storage migration transfer", () => {
  it("authenticates source downloads through both Supabase gateway headers", () => {
    expect(sourceStorageHeaders(" service-role-key ")).toEqual({
      apikey: "service-role-key",
      authorization: "Bearer service-role-key",
    });
    expect(() => sourceStorageHeaders(" ")).toThrow(
      "Source storage service role key is required.",
    );
  });

  it("encodes authenticated source paths without changing hierarchy", () => {
    expect(
      sourceObjectUrl(
        "https://source.example.test",
        "client-logos",
        "client one/logo final.svg",
      ),
    ).toBe(
      "https://source.example.test/storage/v1/object/authenticated/client-logos/client%20one/logo%20final.svg",
    );
  });

  it("maps only the two approved source buckets", () => {
    const targets = {
      assets: "seer-assets",
      exports: "seer-exports",
    };
    expect(targetBucket("client-logos", targets)).toBe("seer-assets");
    expect(targetBucket("slide-exports", targets)).toBe("seer-exports");
    expect(() => targetBucket("unknown", targets)).toThrow(
      "Unexpected source storage bucket",
    );
  });

  it("builds a binary-safe GCS multipart upload with source checksum metadata", () => {
    const upload = buildGcsMultipartUpload(
      {
        bucketId: "client-logos",
        contentType: "image/png",
        name: "client/logo.png",
        sourceId: "object-1",
      },
      Buffer.from([0, 1, 2, 255]),
      "a".repeat(64),
      "seer-boundary",
    );

    expect(upload.contentType).toBe(
      "multipart/related; boundary=seer-boundary",
    );
    expect(upload.body.includes(Buffer.from([0, 1, 2, 255]))).toBe(true);
    expect(upload.body.toString("latin1")).toContain(
      `"seer_source_sha256":"${"a".repeat(64)}"`,
    );
  });

  it("accepts an idempotent target only when size and checksum match", () => {
    expect(
      targetObjectMatches(
        {
          metadata: { seer_source_sha256: "a".repeat(64) },
          size: "4",
        },
        4,
        "a".repeat(64),
      ),
    ).toBe(true);
    expect(
      targetObjectMatches(
        {
          metadata: { seer_source_sha256: "b".repeat(64) },
          size: "4",
        },
        4,
        "a".repeat(64),
      ),
    ).toBe(false);
  });
});
