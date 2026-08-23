import { versionSchema } from "@casei/contracts";

import { ApiHttpError } from "./errors.js";
import type { ApiContext } from "./types.js";

export function etagForVersion(version: number): string {
  assertVersion(version);
  return `"v${version}"`;
}

export function parseIfMatch(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^"v(0|[1-9][0-9]*)"$/.exec(value.trim());
  if (!match) return null;
  const version = Number(match[1]);
  return Number.isSafeInteger(version) && versionSchema.safeParse(version).success ? version : null;
}

export function requireIfMatch(context: ApiContext): number {
  const version = parseIfMatch(context.req.header("If-Match"));
  if (version === null) {
    throw new ApiHttpError(428, "precondition_required");
  }
  return version;
}

export function assertIfMatch(context: ApiContext, currentVersion: number): number {
  const expectedVersion = requireIfMatch(context);
  if (expectedVersion !== currentVersion) {
    throw new ApiHttpError(412, "version_conflict", { currentVersion });
  }
  return expectedVersion;
}

export function setVersionHeaders(context: ApiContext, version: number): void {
  context.header("ETag", etagForVersion(version));
}

function assertVersion(version: number): void {
  if (!Number.isSafeInteger(version) || !versionSchema.safeParse(version).success) {
    throw new RangeError("Version must be a non-negative safe integer");
  }
}
