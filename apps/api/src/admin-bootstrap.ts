export class PlatformBootstrapAlreadyCompletedError extends Error {
  readonly code = "bootstrap_already_completed" as const;

  constructor() {
    super("Platform admin bootstrap has already been completed");
    this.name = "PlatformBootstrapAlreadyCompletedError";
  }
}

export interface PlatformBootstrapStore {
  /** The implementation must lock the platform-admin set and claim atomically. */
  claimFirstPlatformAdmin(userId: string): Promise<void>;
}

export async function bootstrapFirstPlatformAdmin(
  store: PlatformBootstrapStore,
  userId: string,
): Promise<void> {
  const normalized = userId.trim();
  if (!normalized) throw new Error("A user ID is required for platform admin bootstrap");
  await store.claimFirstPlatformAdmin(normalized);
}
