import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { createDatabase, ensureApplicationRole, getDatabasePool } from "@casei/database";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { describe, expect, it } from "vitest";
import { IdentityService, InvitationRateLimitError } from "../src/identity-service.js";
import { runWorkspaceWorkerOnce } from "../src/workspace-worker.js";

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
      const service = new IdentityService(pool, {
        now: () => clock.now,
        authEmailSecret: "test-secret-that-is-longer-than-thirty-two-characters",
      });
      const scope = await service.resolveScope(owner, workspaceId, "01ARZ3NDEKTSV4RRFFQ69G5FAV");
      expect(scope?.role).toBe("owner");
      if (!scope) throw new Error("owner scope was not resolved");

      const initialProfile = await service.getProfile(owner);
      expect(initialProfile).toMatchObject({
        userId: ownerId,
        displayName: "Owner",
        locale: "pt-BR",
        hideValues: false,
        version: 0,
      });
      const updatedProfile = await service.updateProfile(
        owner,
        { displayName: "Owner Casei", locale: "pt-BR", hideValues: true },
        initialProfile.version,
        "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      );
      expect(updatedProfile).toMatchObject({
        displayName: "Owner Casei",
        hideValues: true,
        version: 1,
      });
      const profileAudit = await pool.query<{
        action: string;
        reason: string;
        before_redacted: Record<string, unknown>;
        after_redacted: Record<string, unknown>;
      }>(
        `SELECT action, reason, before_redacted, after_redacted FROM audit_event
          WHERE action = 'identity.profile_updated' AND target_id = $1
          ORDER BY occurred_at DESC LIMIT 1`,
        [ownerId],
      );
      expect(profileAudit.rows[0]).toEqual({
        action: "identity.profile_updated",
        reason: "profile_fields_updated",
        before_redacted: { display_name: "[redacted]", locale: "pt-BR", hide_values: false },
        after_redacted: { display_name: "[redacted]", locale: "pt-BR", hide_values: true },
      });
      expect(JSON.stringify(profileAudit.rows[0])).not.toContain("Owner Casei");
      expect(JSON.stringify(profileAudit.rows[0])).not.toContain("owner@example.test");
      await expect(
        service.updateProfile(
          owner,
          { displayName: "Conflito", locale: "pt-BR", hideValues: false },
          initialProfile.version,
          "01ARZ3NDEKTSV4RRQ69G5FAW",
        ),
      ).rejects.toMatchObject({ name: "IdentityVersionConflictError" });
      const concurrentProfiles = await Promise.allSettled([
        service.updateProfile(
          owner,
          { displayName: "Concorrente A", locale: "pt-BR", hideValues: true },
          updatedProfile.version,
          "01ARZ3NDEKTSV4RRFFQ69G5FAX",
        ),
        service.updateProfile(
          owner,
          { displayName: "Concorrente B", locale: "pt-BR", hideValues: false },
          updatedProfile.version,
          "01ARZ3NDEKTSV4RRFFQ69G5FAY",
        ),
      ]);
      expect(concurrentProfiles.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const concurrentFailure = concurrentProfiles.find((result) => result.status === "rejected");
      expect(concurrentFailure).toMatchObject({
        status: "rejected",
        reason: { name: "IdentityVersionConflictError" },
      });

      const initialPreferences = await service.getWorkspacePreferences(scope);
      expect(initialPreferences).toMatchObject({
        workspaceId,
        name: "Casa lifecycle",
        currency: "BRL",
        timeZone: "America/Fortaleza",
        safetyMarginMinor: "0",
        version: 0,
      });
      const updatedPreferences = await service.updateWorkspacePreferences(
        scope,
        {
          name: "Casa lifecycle",
          currency: "USD",
          timeZone: "America/Sao_Paulo",
          safetyMarginMinor: "1200",
        },
        initialPreferences.version,
      );
      expect(updatedPreferences).toMatchObject({
        currency: "USD",
        timeZone: "America/Sao_Paulo",
        safetyMarginMinor: "1200",
        version: 1,
      });
      const preferenceAudit = await pool.query<{
        action: string;
        reason: string;
        before_redacted: Record<string, unknown>;
        after_redacted: Record<string, unknown>;
      }>(
        `SELECT action, reason, before_redacted, after_redacted FROM audit_event
          WHERE action = 'workspace.preferences_updated' AND target_id = $1
          ORDER BY occurred_at DESC LIMIT 1`,
        [workspaceId],
      );
      expect(preferenceAudit.rows[0]).toEqual({
        action: "workspace.preferences_updated",
        reason: "workspace_preference_fields_updated",
        before_redacted: {
          name: "[redacted]",
          currency: "BRL",
          time_zone: "America/Fortaleza",
          safety_margin_minor: "[redacted]",
        },
        after_redacted: {
          name: "[redacted]",
          currency: "USD",
          time_zone: "America/Sao_Paulo",
          safety_margin_minor: "[redacted]",
        },
      });
      expect(JSON.stringify(preferenceAudit.rows[0])).not.toContain("America/Sao_Paulo");
      expect(JSON.stringify(preferenceAudit.rows[0])).not.toContain("USD");
      const noMovementPreferences = await service.updateWorkspacePreferences(
        scope,
        {
          name: "Casa lifecycle",
          currency: "EUR",
          timeZone: "America/Sao_Paulo",
          safetyMarginMinor: "1200",
        },
        updatedPreferences.version,
      );
      expect(noMovementPreferences.currency).toBe("EUR");
      await pool.query(
        `INSERT INTO finance_transaction
          (workspace_id, kind, state, instrument, amount_minor, settled_minor, currency_code, occurred_on, description)
         VALUES ($1, 'expense', 'planned', 'wallet', 100, 0, 'EUR', '2030-01-01', 'compromisso')`,
        [workspaceId],
      );
      const plannedPreferences = await service.getWorkspacePreferences(scope);
      await expect(
        service.updateWorkspacePreferences(
          scope,
          {
            name: "Casa lifecycle",
            currency: "BRL",
            timeZone: "America/Sao_Paulo",
            safetyMarginMinor: "1200",
          },
          plannedPreferences.version,
        ),
      ).rejects.toMatchObject({ name: "IdentityConflictError" });
      await pool.query(
        `DELETE FROM finance_transaction
          WHERE workspace_id = $1 AND state = 'planned'`,
        [workspaceId],
      );
      await pool.query(
        `INSERT INTO finance_transaction
          (workspace_id, kind, state, instrument, amount_minor, settled_minor, currency_code, occurred_on, description)
         VALUES ($1, 'expense', 'posted', 'wallet', 100, 100, 'EUR', '2030-01-01', 'teste')`,
        [workspaceId],
      );
      const movementPreferences = await service.getWorkspacePreferences(scope);
      await expect(
        service.updateWorkspacePreferences(
          scope,
          {
            name: "Casa lifecycle",
            currency: "BRL",
            timeZone: "America/Sao_Paulo",
            safetyMarginMinor: "1200",
          },
          movementPreferences.version,
        ),
      ).rejects.toMatchObject({ name: "IdentityConflictError" });

      const invitation = await service.createInvitation(
        scope,
        { email: `invite-${suffix}@example.test`, role: "viewer" },
        "auth005-invite-key",
      );
      expect(invitation.invitation.inviteUrl).toContain("/invite/");
      const outbox = await pool.query<{ encrypted_payload: string }>(
        `SELECT encrypted_payload FROM auth_email_outbox WHERE message_kind = 'invitation' AND source_id = $1`,
        [invitation.invitation.id],
      );
      expect(outbox.rows).toHaveLength(1);
      expect(outbox.rows[0]?.encrypted_payload).not.toContain(invitation.invitation.inviteUrl);
      expect(outbox.rows[0]?.encrypted_payload).not.toContain(invitation.invitation.email);
      /* The payload is authenticated ciphertext; only the worker decrypts it. */
      const outboxState = await pool.query<{ state: string }>(
        `SELECT state FROM auth_email_outbox WHERE message_kind = 'invitation' AND source_id = $1`,
        [invitation.invitation.id],
      );
      expect(outboxState.rows).toEqual([{ state: "pending" }]);

      const resent = await service.resendInvitation(
        scope,
        invitation.invitation.id,
        "auth005-resend-invite-key",
      );
      await expect(
        pool.query(
          `SELECT id FROM auth_email_outbox WHERE message_kind = 'invitation' AND source_id = $1`,
          [invitation.invitation.id],
        ),
      ).resolves.toMatchObject({ rows: [] });
      await expect(
        pool.query(
          `SELECT id FROM auth_email_outbox WHERE message_kind = 'invitation' AND source_id = $1`,
          [resent.invitation.id],
        ),
      ).resolves.toMatchObject({ rows: [{ id: expect.any(String) }] });
      await service.revokeInvitation(scope, resent.invitation.id, "auth005-revoke-invite-key");
      await expect(
        pool.query(
          `SELECT id FROM auth_email_outbox WHERE message_kind = 'invitation' AND source_id = $1`,
          [resent.invitation.id],
        ),
      ).resolves.toMatchObject({ rows: [] });

      const acceptedInvitation = await service.createInvitation(
        scope,
        { email: `${revokedId}@example.test`, role: "viewer" },
        "auth005-accepted-invite-key",
      );
      const acceptedToken = decodeURIComponent(
        acceptedInvitation.invitation.inviteUrl?.split("/invite/")[1] ?? "",
      );
      await service.acceptInvitation(
        { userId: revokedId, email: `${revokedId}@example.test` },
        acceptedToken,
        "01ARZ3NDEKTSV4RRFFQ69G5FB0",
      );
      await expect(
        pool.query(
          `SELECT id FROM auth_email_outbox WHERE message_kind = 'invitation' AND source_id = $1`,
          [acceptedInvitation.invitation.id],
        ),
      ).resolves.toMatchObject({ rows: [] });
      await pool.query(
        `UPDATE membership SET role = 'member', status = 'revoked' WHERE workspace_id = $1 AND user_id = $2`,
        [workspaceId, revokedId],
      );

      const expiringInvitation = await service.createInvitation(
        scope,
        { email: `expired-${suffix}@example.test`, role: "viewer" },
        "auth005-expiring-invite-key",
      );
      const expiringToken = decodeURIComponent(
        expiringInvitation.invitation.inviteUrl?.split("/invite/")[1] ?? "",
      );
      clock.now = new Date("2030-01-09T00:00:00.000Z");
      await expect(
        service.acceptInvitation(
          { userId: `expired-acceptor-${suffix}`, email: `expired-${suffix}@example.test` },
          expiringToken,
          "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
        ),
      ).rejects.toThrow();
      await expect(
        pool.query<{ status: string }>(`SELECT status FROM workspace_invitation WHERE id = $1`, [
          expiringInvitation.invitation.id,
        ]),
      ).resolves.toMatchObject({ rows: [{ status: "expired" }] });
      clock.now = new Date("2030-01-01T00:00:00.000Z");
      for (let index = 0; index < 2; index += 1) {
        await service.createInvitation(
          scope,
          { email: `rate-${index}-${suffix}@example.test`, role: "viewer" },
          `auth005-rate-key-${index}`,
        );
      }
      await expect(
        service.createInvitation(
          scope,
          { email: `rate-blocked-${suffix}@example.test`, role: "viewer" },
          "auth005-rate-key-blocked",
        ),
      ).rejects.toBeInstanceOf(InvitationRateLimitError);
      await expect(
        pool.query<{ attempts: number }>(
          `SELECT attempts FROM workspace_invitation_rate_limit
            WHERE workspace_id = $1 AND actor_user_id = $2 AND action = 'create'`,
          [workspaceId, ownerId],
        ),
      ).resolves.toMatchObject({ rows: [{ attempts: 5 }] });

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
        2,
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
          2,
        ),
      ).resolves.toEqual(first);
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

      await service.cancelDeactivation(
        owner,
        workspaceId,
        "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        first.version,
      );
      const afterCancel = await pool.query<{ user_id: string; status: string }>(
        `SELECT user_id, status FROM membership WHERE workspace_id = $1 ORDER BY user_id`,
        [workspaceId],
      );
      expect(afterCancel.rows).toEqual([
        { user_id: memberId, status: "active" },
        { user_id: ownerId, status: "active" },
        { user_id: revokedId, status: "revoked" },
      ]);
      await expect(
        pool.query<{ state: string }>(
          `SELECT state FROM job WHERE job_type = 'workspace.purge' AND workspace_id = $1`,
          [workspaceId],
        ),
      ).resolves.toMatchObject({ rows: [{ state: "cancelled" }] });

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
        4,
      );
      await expect(
        pool.query<{ reason: string }>(
          `SELECT reason FROM audit_event
             WHERE action = 'workspace.deletion_requested' AND target_id = $1
             ORDER BY occurred_at DESC LIMIT 1`,
          [workspaceId],
        ),
      ).resolves.toMatchObject({ rows: [{ reason: "teste do cutoff" }] });
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
        pool.query(`SELECT id FROM workspace WHERE id = $1`, [workspaceId]),
      ).resolves.toMatchObject({ rows: [] });
      await expect(
        pool.query<{
          status: string;
          deactivated_at: Date;
          purge_at: Date;
          backup_expires_at: Date;
          audit_purge_at: Date;
          pseudonymous_owner_hash: string;
        }>(
          `SELECT status, deactivated_at, purge_at, backup_expires_at, audit_purge_at,
                  pseudonymous_owner_hash
             FROM workspace_tombstone WHERE workspace_id = $1`,
          [workspaceId],
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            status: "deactivated",
            deactivated_at: new Date("2030-01-01T00:00:00.000Z"),
            purge_at: new Date("2030-01-31T00:00:00.000Z"),
            backup_expires_at: new Date("2030-02-05T00:00:00.000Z"),
            audit_purge_at: new Date("2031-01-01T00:00:00.000Z"),
          },
        ],
      });
      const tombstone = await pool.query<{
        pseudonymous_owner_hash: string;
      }>(`SELECT pseudonymous_owner_hash FROM workspace_tombstone WHERE workspace_id = $1`, [
        workspaceId,
      ]);
      expect(tombstone.rows[0]?.pseudonymous_owner_hash).toMatch(/^[0-9a-f]{64}$/);
      await expect(
        pool.query(`SELECT app.assert_workspace_restore_allowed($1)`, [workspaceId]),
      ).rejects.toBeTruthy();
      await expect(
        pool.query(`SELECT app.assert_workspace_backup_allowed($1, $2)`, [
          workspaceId,
          "2030-02-04T23:59:59.999Z",
        ]),
      ).resolves.toBeTruthy();
      await expect(
        pool.query(`SELECT app.assert_workspace_backup_allowed($1, $2)`, [
          workspaceId,
          "2030-02-05T00:00:00.000Z",
        ]),
      ).rejects.toBeTruthy();
      await expect(
        pool.query(`INSERT INTO workspace (id, name) VALUES ($1, 'rehydration')`, [workspaceId]),
      ).rejects.toBeTruthy();
      const lifecycleAudit = await pool.query<{ reason: string; retention_until: Date }>(
        `SELECT reason, retention_until
           FROM audit_event
          WHERE action = 'workspace.deletion_requested' AND target_id = $1`,
        [workspaceId],
      );
      expect(lifecycleAudit.rows[0]?.reason).toBe("deactivation_reason_redacted");
      expect(lifecycleAudit.rows[0]?.retention_until).toEqual(new Date("2031-01-01T00:00:00.000Z"));
      await expect(
        service.purgeExpiredTombstones(new Date("2030-12-31T23:59:59.999Z")),
      ).resolves.toMatchObject({ tombstones: 0 });
      const previousWorkerUrl = process.env.DATABASE_URL_WORKER;
      process.env.DATABASE_URL_WORKER = databaseUrl.toString();
      try {
        await expect(
          runWorkspaceWorkerOnce(new Date("2031-01-01T00:00:00.000Z")),
        ).resolves.toBeGreaterThan(0);
      } finally {
        if (previousWorkerUrl === undefined) delete process.env.DATABASE_URL_WORKER;
        else process.env.DATABASE_URL_WORKER = previousWorkerUrl;
      }
      await expect(
        pool.query(`SELECT workspace_id FROM workspace_tombstone WHERE workspace_id = $1`, [
          workspaceId,
        ]),
      ).resolves.toMatchObject({ rows: [] });
      await expect(
        pool.query(
          `SELECT id FROM audit_event
            WHERE action = 'workspace.deletion_requested' AND target_id = $1`,
          [workspaceId],
        ),
      ).resolves.toMatchObject({ rows: [] });
    } finally {
      await pool?.end();
      await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await adminPool.end();
    }
  });
});
