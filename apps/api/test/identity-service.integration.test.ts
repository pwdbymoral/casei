import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { createDatabase, ensureApplicationRole, getDatabasePool } from "@casei/database";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { describe, expect, it } from "vitest";
import { IdentityService } from "../src/identity-service.js";

const adminUrl = process.env.DATABASE_URL_TEST;
const integrationIt = adminUrl ? it : it.skip;

describe("AUTH-005 lifecycle PostgreSQL", () => {
  integrationIt("preserves membership state, retries recovery and purges on day 30", async () => {
    if (!adminUrl) return;
    const adminPool = getDatabasePool({ connectionString: adminUrl });
    const suffix = randomUUID().replaceAll("-", "");
    const databaseName = `casei_auth005_${suffix}`;
    const databaseUrl = new URL(adminUrl);
    databaseUrl.pathname = `/${databaseName}`;
    let pool: ReturnType<typeof getDatabasePool> | undefined;
    const clock = { now: new Date("2030-01-01T00:00:00.000Z") };
    const ownerId = `auth005-owner-${suffix}`;
    const memberId = `auth005-member-${suffix}`;
    const revokedId = `auth005-revoked-${suffix}`;
    const onboardingId = `auth005-onboarding-${suffix}`;

    try {
      await ensureApplicationRole(adminPool);
      await adminPool.query(`CREATE DATABASE "${databaseName}"`);
      pool = getDatabasePool({ connectionString: databaseUrl.toString() });
      await migrate(createDatabase(pool), {
        migrationsFolder: fileURLToPath(
          new URL("../../../packages/database/drizzle", import.meta.url),
        ),
      });

      const workspace = await pool.query<{ id: string }>(
        `INSERT INTO workspace (name) VALUES ('Casa lifecycle') RETURNING id`,
      );
      const workspaceId = workspace.rows[0]?.id;
      expect(workspaceId).toBeTruthy();
      if (!workspaceId) throw new Error("workspace was not created");
      await pool.query(
        `INSERT INTO workspace_preference (workspace_id, currency_code, timezone)
         VALUES ($1, 'BRL', 'America/Fortaleza')`,
        [workspaceId],
      );
      await pool.query(
        `INSERT INTO "user" (id, name, email, email_verified) VALUES
          ($1, 'Owner', $5, true), ($2, 'Membro', $6, true), ($3, 'Revogado', $7, true),
          ($4, 'Onboarding', $8, true)`,
        [
          ownerId,
          memberId,
          revokedId,
          onboardingId,
          `${ownerId}@example.test`,
          `${memberId}@example.test`,
          `${revokedId}@example.test`,
          `${onboardingId}@example.test`,
        ],
      );
      await pool.query(
        `INSERT INTO membership (workspace_id, user_id, role, status) VALUES
          ($1, $2, 'owner', 'active'), ($1, $3, 'member', 'active'), ($1, $4, 'viewer', 'revoked')`,
        [workspaceId, ownerId, memberId, revokedId],
      );

      const owner = {
        userId: ownerId,
        email: `${ownerId}@example.test`,
        recentAuthentication: true,
      };
      const service = new IdentityService(pool, { now: () => clock.now });
      const scope = await service.resolveScope(owner, workspaceId, "01ARZ3NDEKTSV4RRFFQ69G5FAV");
      expect(scope?.role).toBe("owner");
      if (!scope) throw new Error("owner scope was not resolved");

      const invitation = await service.createInvitation(
        scope,
        { email: `invite-${suffix}@example.test`, role: "viewer" },
        "auth005-invite-key",
      );
      expect(invitation.invitation.inviteUrl).toContain("/invite/");
      const outbox = await pool.query<{ payload: unknown }>(
        `SELECT payload FROM outbox_event WHERE event_type = 'workspace.invitation_created' AND workspace_id = $1`,
        [workspaceId],
      );
      expect(outbox.rows).toHaveLength(1);
      expect(outbox.rows[0]?.payload).toEqual({
        invitationId: invitation.invitation.id,
        email: `invite-${suffix}@example.test`,
        role: "viewer",
      });
      expect(JSON.stringify(outbox.rows[0]?.payload)).not.toContain(
        invitation.invitation.inviteUrl,
      );

      const onboardingResults = await Promise.all([
        service.createOnboarding(
          { userId: onboardingId, email: `${onboardingId}@example.test` },
          {
            displayName: "Onboarding 1",
            workspaceName: "Casa concorrente 1",
            currency: "BRL",
            timeZone: "America/Fortaleza",
            initialBalanceMinor: "0",
            includeInitialBalance: false,
          },
          "auth005-onboarding-key-a",
          "01ARZ3NDEKTSV4RRFFQ69G5FAA",
        ),
        service.createOnboarding(
          { userId: onboardingId, email: `${onboardingId}@example.test` },
          {
            displayName: "Onboarding 2",
            workspaceName: "Casa concorrente 2",
            currency: "BRL",
            timeZone: "America/Fortaleza",
            initialBalanceMinor: "0",
            includeInitialBalance: false,
          },
          "auth005-onboarding-key-b",
          "01ARZ3NDEKTSV4RRFFQ69G5FAB",
        ),
      ]);
      expect(onboardingResults[0]?.workspace.id).toBe(onboardingResults[1]?.workspace.id);
      await expect(
        pool.query(
          `SELECT count(*)::int AS count FROM membership WHERE user_id = $1 AND role = 'owner'`,
          [onboardingId],
        ),
      ).resolves.toMatchObject({ rows: [{ count: 1 }] });

      const first = await service.deactivateWorkspace(
        scope,
        {
          workspaceName: "Casa lifecycle",
          reason: "teste de ciclo de vida",
        },
        0,
      );
      expect(first.recoveryUntil).toBe("2030-01-31T00:00:00.000Z");
      await expect(
        service.retryDeactivation(
          owner,
          workspaceId,
          {
            workspaceName: "Casa lifecycle",
            reason: "retry após perda de resposta",
          },
          "01ARZ3NDEKTSV4RRFFQ69G5FAV",
          first.version,
        ),
      ).resolves.toEqual(first);

      const afterDeactivate = await pool.query<{ user_id: string; status: string }>(
        `SELECT user_id, status FROM membership WHERE workspace_id = $1 ORDER BY user_id`,
        [workspaceId],
      );
      expect(afterDeactivate.rows).toEqual([
        { user_id: memberId, status: "recovery_only" },
        { user_id: ownerId, status: "recovery_only" },
        { user_id: revokedId, status: "revoked" },
      ]);
      await expect(service.getSession(owner)).resolves.toMatchObject({
        workspaces: [
          expect.objectContaining({
            id: workspaceId,
            status: "deletion_pending",
            role: "owner",
          }),
        ],
      });
      await expect(
        pool.query<{ actor_id: string | null; required_capability: string; state: string }>(
          `SELECT actor_id, required_capability, state FROM job WHERE job_type = 'workspace.purge' AND workspace_id = $1`,
          [workspaceId],
        ),
      ).resolves.toMatchObject({
        rows: [{ actor_id: null, required_capability: "system.purge", state: "pending" }],
      });

      await service.cancelDeactivation(owner, workspaceId, "01ARZ3NDEKTSV4RRFFQ69G5FAV");
      const afterCancel = await pool.query<{ user_id: string; status: string }>(
        `SELECT user_id, status FROM membership WHERE workspace_id = $1 ORDER BY user_id`,
        [workspaceId],
      );
      expect(afterCancel.rows).toEqual([
        { user_id: memberId, status: "active" },
        { user_id: ownerId, status: "active" },
        { user_id: revokedId, status: "revoked" },
      ]);

      const scopeAfterCancel = await service.resolveScope(
        owner,
        workspaceId,
        "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      );
      expect(scopeAfterCancel?.role).toBe("owner");
      if (!scopeAfterCancel) throw new Error("owner scope was not restored");
      await service.deactivateWorkspace(
        scopeAfterCancel,
        {
          workspaceName: "Casa lifecycle",
          reason: "teste do cutoff",
        },
        2,
      );
      clock.now = new Date("2030-01-30T23:59:59.999Z");
      await expect(service.getRecovery(owner, workspaceId)).resolves.toMatchObject({
        status: "active",
      });
      const early = await service.createPurgeWorker().runOnce(workspaceId, clock.now);
      expect(early.state).toBe("idle");

      clock.now = new Date("2030-01-31T00:00:00.000Z");
      await expect(service.getRecovery(owner, workspaceId)).resolves.toMatchObject({
        status: "expired",
      });
      const purged = await service.createPurgeWorker().runOnce(workspaceId, clock.now);
      expect(purged.state).toBe("succeeded");
      await expect(
        pool.query(`SELECT workspace_id FROM workspace WHERE id = $1`, [workspaceId]),
      ).resolves.toMatchObject({ rows: [] });
      await expect(
        pool.query(`SELECT status FROM workspace_tombstone WHERE workspace_id = $1`, [workspaceId]),
      ).resolves.toMatchObject({ rows: [{ status: "deactivated" }] });
      await expect(
        pool.query(`INSERT INTO workspace (id, name) VALUES ($1, 'rehydration')`, [workspaceId]),
      ).rejects.toBeTruthy();
    } finally {
      await pool?.end();
      await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await adminPool.end();
    }
  });
});
