import { describe, expect, it } from "vitest";
import {
  bootstrapFirstPlatformAdmin,
  PlatformBootstrapAlreadyCompletedError,
  type PlatformBootstrapStore,
} from "../src/admin-bootstrap.js";

class MemoryBootstrapStore implements PlatformBootstrapStore {
  activeAdmins = 0;
  existingPlatformAccounts = 0;
  claimed: string | null = null;

  async claimFirstPlatformAdmin(userId: string): Promise<void> {
    if (this.existingPlatformAccounts > 0 || this.activeAdmins > 0) {
      throw new PlatformBootstrapAlreadyCompletedError();
    }
    this.activeAdmins = 1;
    this.existingPlatformAccounts = 1;
    this.claimed = userId;
  }
}

describe("ADMIN-001 bootstrap", () => {
  it("allows a single explicit first-admin claim", async () => {
    const store = new MemoryBootstrapStore();
    await bootstrapFirstPlatformAdmin(store, "first-user");
    expect(store.claimed).toBe("first-user");
    await expect(bootstrapFirstPlatformAdmin(store, "second-user")).rejects.toBeInstanceOf(
      PlatformBootstrapAlreadyCompletedError,
    );
  });

  it("does not accept an empty or ambiguous operator target", async () => {
    const store = new MemoryBootstrapStore();
    await expect(bootstrapFirstPlatformAdmin(store, " ")).rejects.toThrow("user ID");
  });

  it("does not re-bootstrap over a suspended platform account", async () => {
    const store = new MemoryBootstrapStore();
    store.existingPlatformAccounts = 1;
    await expect(bootstrapFirstPlatformAdmin(store, "replacement-user")).rejects.toBeInstanceOf(
      PlatformBootstrapAlreadyCompletedError,
    );
  });
});
