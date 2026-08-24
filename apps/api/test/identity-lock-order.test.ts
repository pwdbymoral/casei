import { describe, expect, it } from "vitest";
import { IdentityPermissionError, IdentityService } from "../src/identity-service.js";

const scope = {
  actor: { userId: "user-z-owner", email: "owner@example.test", recentAuthentication: true },
  workspaceId: "0190f3c8-2a10-7abc-8def-1234567890ab",
  role: "owner" as const,
  correlationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
};

function poolFor(options: { lockedActorRole?: "owner" | "member" } = {}) {
  const statements: string[] = [];
  const parameters: unknown[][] = [];
  const client = {
    async query<T>(sql: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number }> {
      statements.push(sql);
      parameters.push(values ?? []);
      if (sql.includes("FROM membership m JOIN workspace")) {
        return { rows: [{ role: "owner", status: "active" }] as T[], rowCount: 1 };
      }
      if (sql.includes("FROM membership")) {
        return {
          rows: [
            {
              user_id: "user-z-owner",
              role: options.lockedActorRole ?? "owner",
              status: "active",
              version: 0,
            },
            { user_id: "user-a-target", role: "member", status: "active", version: 0 },
          ] as T[],
          rowCount: 2,
        };
      }
      if (sql.includes("FROM workspace")) {
        return {
          rows: [{ id: scope.workspaceId, name: "Casa", status: "active", version: 0 }] as T[],
          rowCount: 1,
        };
      }
      return { rows: [] as T[], rowCount: 0 };
    },
    release() {},
  };
  return {
    pool: {
      async connect() {
        return client;
      },
    },
    statements,
    parameters,
  };
}

function lockQueries(statements: string[]): string[] {
  return statements.filter((sql) => sql.includes("FOR UPDATE"));
}

describe("IdentityService workspace lock ordering", () => {
  it("locks transfer memberships in deterministic user order before the workspace", async () => {
    const harness = poolFor();
    const service = new IdentityService(harness.pool as never);

    await expect(service.transferOwnership(scope, "user-a-target", 0)).resolves.toEqual({
      version: 1,
    });

    const locks = lockQueries(harness.statements);
    const membershipLock = locks[0];
    const workspaceLock = locks[1];
    if (!membershipLock || !workspaceLock)
      throw new Error("expected membership and workspace locks");
    expect(membershipLock).toMatch(/FROM membership/);
    expect(membershipLock).toMatch(/ORDER BY user_id ASC/);
    expect(membershipLock).toMatch(/ANY\(\$2::text\[\]\)/);
    const transferMembershipLock = harness.statements.findIndex((sql) =>
      sql.includes("ANY($2::text[])"),
    );
    expect(harness.parameters[transferMembershipLock]).toEqual([
      scope.workspaceId,
      ["user-a-target", "user-z-owner"],
    ]);
    expect(workspaceLock).toMatch(/FROM workspace/);
    expect(locks.indexOf(workspaceLock)).toBeGreaterThan(locks.indexOf(membershipLock));
  });

  it("locks every deactivation membership in deterministic order before the workspace", async () => {
    const harness = poolFor();
    const service = new IdentityService(harness.pool as never, {
      now: () => new Date("2030-01-01T00:00:00.000Z"),
    });

    await expect(
      service.deactivateWorkspace(scope, { workspaceName: "Casa", reason: "teste" }, 0),
    ).resolves.toMatchObject({ version: 1 });

    const locks = lockQueries(harness.statements);
    const membershipLock = locks[0];
    const workspaceLock = locks[1];
    if (!membershipLock || !workspaceLock)
      throw new Error("expected membership and workspace locks");
    expect(membershipLock).toMatch(/FROM membership/);
    expect(membershipLock).toMatch(/ORDER BY user_id ASC/);
    expect(workspaceLock).toMatch(/FROM workspace/);
    expect(locks.indexOf(workspaceLock)).toBeGreaterThan(locks.indexOf(membershipLock));
  });

  it("rechecks the actor role after taking the canonical membership locks", async () => {
    const harness = poolFor({ lockedActorRole: "member" });
    const service = new IdentityService(harness.pool as never);

    await expect(service.transferOwnership(scope, "user-a-target", 0)).rejects.toBeInstanceOf(
      IdentityPermissionError,
    );
    expect(harness.statements.some((sql) => sql.includes("UPDATE membership"))).toBe(false);
  });
});
