import { describe, expect, it, vi } from "vitest";

import type { AccessTokenProvider } from "../../runtime/src/google-auth.js";
import { GcsMigrationEvidenceStore } from "../src/managed-evidence.js";

const tokenProvider: AccessTokenProvider = {
  getAccessToken: async () => "test-token",
};

describe("managed database migration evidence", () => {
  it("reads plans and treats a missing checkpoint as absent", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{"version":2}', { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const store = new GcsMigrationEvidenceStore(
      "test-project-seer-migration-evidence",
      tokenProvider,
      fetchImplementation,
    );

    await expect(store.get("database/archive-plan.json")).resolves.toEqual(
      Buffer.from('{"version":2}'),
    );
    await expect(
      store.get("database/archive-checkpoint.json"),
    ).resolves.toBeNull();
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("creates a generation-bound lock and releases only that generation", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ generation: "42" }, { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const store = new GcsMigrationEvidenceStore(
      "test-project-seer-migration-evidence",
      tokenProvider,
      fetchImplementation,
    );

    const generation = await store.acquireLock(
      "database/archive.lock",
      "execution-1",
    );
    await store.releaseLock("database/archive.lock", generation);

    expect(generation).toBe("42");
    expect(fetchImplementation.mock.calls[0]?.[0]).toContain(
      "ifGenerationMatch=0",
    );
    expect(fetchImplementation.mock.calls[1]?.[0]).toContain(
      "ifGenerationMatch=42",
    );
  });

  it("refuses a concurrent transfer when the lock already exists", async () => {
    const store = new GcsMigrationEvidenceStore(
      "test-project-seer-migration-evidence",
      tokenProvider,
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(null, { status: 412 }),
      ),
    );

    await expect(
      store.acquireLock("database/canonical.lock", "execution-2"),
    ).rejects.toThrow("holds the lock");
  });

  it("rejects traversal in evidence object names", async () => {
    const store = new GcsMigrationEvidenceStore(
      "test-project-seer-migration-evidence",
      tokenProvider,
      vi.fn<typeof fetch>(),
    );

    await expect(store.get("database/../secret.json")).rejects.toThrow(
      "object name is invalid",
    );
  });
});
