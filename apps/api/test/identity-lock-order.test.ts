import { describe, expect, it } from "vitest";
import { IdentityPermissionError, IdentityService } from "../src/identity-service.js";

const scope = {
  actor: { userId: "user-z-owner", email: "owner@example.test", recentAuthentication: true },
  workspaceId: "0190f3c8-2a10-7abc-8def-1234567890ab",
  role: "owner" as const,
  correlationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
};

function poolFor(options: { actorRole?: "owner" | "member" } = {}) {
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
              user_id: "user-a-target",
              role: "member",
              status: "active",
              version: 0,
            },
            {
              user_id: "user-z-owner",
              role: options.actorRole ?? "owner",
              status: "active",
              version: 0,
            },
          ] as T[],
          rowCount: 2,
        };
      }
      if (sql.includes("FROM workspace")) {
        return {
          rows: [{ name: "Casa", status: "active", version: 0 }] as T[],
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

function forUpdateStatements(statements: string[]) {
  return statements.filter((statement) => statement.includes("FOR UPDATE"));
}

describe("IdentityService workspace lock ordering", () => {
  it("locks transfer memberships in sorted user order before workspace", async () => {
    const harness = poolFor();
    const service = new IdentityService(harness.pool as never);

    await expect(service.transferOwnership(scope, "user-a-target", 0)).resolves.toEqual({
      version: 1,
    });

    const locks = forUpdateStatements(harness.statements);
    expect(locks[0]).toMatch(/FROM membership/);
    expect(locks[0]).toMatch(/ORDER BY user_id ASC/);
    expect(locks[1]).toMatch(/FROM workspace/);
    const transferLock = harness.statements.findIndex((statement) =>
      statement.includes("ANY($2::text[]"),
    );
    expect(harness.parameters[transferLock]).toEqual([
      scope.workspaceId,
      ["user-a-target", "user-z-owner"],
    ]);
  });

  it("rechecks the actor role after taking canonical locks", async () => {
    const harness = poolFor({ actorRole: "member" });
    const service = new IdentityService(harness.pool as never);

    await expect(service.transferOwnership(scope, "user-a-target", 0)).rejects.toBeInstanceOf(
      IdentityPermissionError,
    );
    expect(harness.statements.some((statement) => statement.includes("UPDATE membership"))).toBe(
      false,
    );
  });

  it("locks every deactivation membership before workspace", async () => {
    const harness = poolFor();
    const service = new IdentityService(harness.pool as never, {
      now: () => new Date("2030-01-01T00:00:00.000Z"),
    });

    await expect(
      service.deactivateWorkspace(scope, { workspaceName: "Casa", reason: "teste" }, 0),
    ).resolves.toMatchObject({ version: 1 });

    const locks = forUpdateStatements(harness.statements);
    expect(locks[0]).toMatch(/FROM membership/);
    expect(locks[0]).toMatch(/ORDER BY user_id ASC/);
    expect(locks[1]).toMatch(/FROM workspace/);
  });
});
