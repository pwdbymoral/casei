import { createHash, randomBytes } from "node:crypto";
import {
  createInvitationSchema,
  deactivateWorkspaceSchema,
  onboardingSchema,
  updateMembershipRoleSchema,
  updateUserProfileSchema,
  updateWorkspacePreferencesSchema,
  type WorkspaceRole,
} from "@casei/contracts";
import {
  executeIdempotent,
  JobAuthorizationError,
  JobLeaseLostError,
  type JsonValue,
  type Pool,
  type PoolClient,
  PostgresJobWorker,
  withUnitOfWork,
} from "@casei/database";
import {
  type AuthEmailMessage,
  encryptAuthEmailPayload,
  hashAuthEmailAddress,
} from "./auth-email.js";

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const INVITATION_RATE_WINDOW_MS = 10 * 60 * 1_000;
const INVITATION_RATE_LIMIT = 5;
const RECOVERY_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const AUDIT_RETENTION_MS = 365 * 24 * 60 * 60 * 1_000;
const BACKUP_RETENTION_MS = 35 * 24 * 60 * 60 * 1_000;

export interface IdentityActor {
  userId: string;
  email?: string;
  displayName?: string;
  recentAuthentication?: boolean;
}

export interface IdentityScope {
  actor: IdentityActor;
  workspaceId: string;
  role: WorkspaceRole;
  correlationId: string;
}

export interface IdentityServiceOptions {
  applicationRole?: string;
  webOrigin?: string;
  authEmailSecret?: string;
  now?: () => Date;
}

export interface WorkspaceSummaryView {
  id: string;
  name: string;
  role: WorkspaceRole;
  locale: "pt-BR";
  timeZone: string;
  currency: string;
  status: "active" | "deletion_pending" | "deactivated";
  version: number;
}

export interface WorkspaceSessionView {
  user: { id: string; displayName: string; email: string };
  workspaces: WorkspaceSummaryView[];
}

export interface UserProfileView {
  userId: string;
  displayName: string;
  email: string;
  emailVerified: boolean;
  locale: "pt-BR";
  hideValues: boolean;
  version: number;
}

export interface WorkspacePreferencesView {
  workspaceId: string;
  name: string;
  currency: string;
  timeZone: string;
  safetyMarginMinor: string;
  version: number;
}

export interface InvitationView {
  id: string;
  workspaceId: string;
  email: string;
  role: "member" | "viewer";
  status: "pending" | "accepted" | "revoked" | "expired";
  expiresAt: string;
  inviteUrl?: string;
}

export interface WorkspaceMemberView {
  userId: string;
  displayName: string;
  email: string;
  role: WorkspaceRole;
  status: "active" | "revoked" | "recovery_only";
  version: number;
}

export interface WorkspaceMembersView {
  members: WorkspaceMemberView[];
}

export interface WorkspaceInvitationsView {
  invitations: InvitationView[];
}

export class IdentityNotFoundError extends Error {
  readonly code = "not_found" as const;
  constructor() {
    super("Workspace or membership not found");
    this.name = "IdentityNotFoundError";
  }
}

export class IdentityPermissionError extends Error {
  readonly code = "permission_denied" as const;
  constructor() {
    super("The actor is not allowed to perform this action");
    this.name = "IdentityPermissionError";
  }
}

export class IdentityConflictError extends Error {
  readonly code = "conflict" as const;
  constructor(message = "") {
    super(message);
    this.name = "IdentityConflictError";
  }
}

export class IdentityVersionConflictError extends Error {
  readonly code = "version_conflict" as const;
  constructor(readonly currentVersion: number) {
    super("O membro foi alterado. Recarregue a lista antes de tentar novamente.");
    this.name = "IdentityVersionConflictError";
  }
}

export class IdentityRecentAuthError extends Error {
  readonly code = "recent_auth_required" as const;
  constructor() {
    super("Recent authentication is required for this action");
    this.name = "IdentityRecentAuthError";
  }
}

export class InvitationRateLimitError extends Error {
  readonly code = "rate_limited" as const;
  constructor(readonly retryAfterSeconds: number) {
    super("O limite de convites foi atingido. Tente novamente mais tarde.");
    this.name = "InvitationRateLimitError";
  }
}

type JsonObject = { [key: string]: JsonValue };

export class IdentityService {
  private readonly applicationRole: string;
  private readonly webOrigin: string;
  private readonly authEmailSecret: string;
  private readonly now: () => Date;

  constructor(
    private readonly pool: Pool,
    options: IdentityServiceOptions = {},
  ) {
    this.applicationRole = options.applicationRole ?? "casei_app";
    this.webOrigin = (
      options.webOrigin ??
      process.env.CASEI_WEB_ORIGIN ??
      "http://localhost:3000"
    ).replace(/\/$/, "");
    this.authEmailSecret = options.authEmailSecret ?? process.env.BETTER_AUTH_SECRET ?? "";
    this.now = options.now ?? (() => new Date());
  }

  async getSession(actor: IdentityActor): Promise<WorkspaceSessionView> {
    if (!actor.email) throw new IdentityNotFoundError();
    return withUnitOfWork(
      this.pool,
      {
        actorId: actor.userId,
        actorEmail: normalizeEmail(actor.email),
        applicationRole: this.applicationRole,
      },
      async ({ client }) => {
        const user = await client.query<{ name: string; email: string }>(
          `SELECT name, email FROM "user" WHERE id = $1`,
          [actor.userId],
        );
        const userRow = user.rows[0];
        if (!userRow) throw new IdentityNotFoundError();
        const memberships = await client.query<WorkspaceSummaryRow>(
          `SELECT w.id, w.name, w.status, w.version, m.role, p.timezone, p.currency_code
             FROM membership m
             JOIN workspace w ON w.id = m.workspace_id
             JOIN workspace_preference p ON p.workspace_id = w.id
            WHERE m.user_id = $1
              AND (
                (m.status = 'active' AND w.status = 'active')
                OR (
                  m.role = 'owner' AND m.status = 'recovery_only'
                  AND w.status = 'deletion_pending'
                  AND EXISTS (
                    SELECT 1 FROM workspace_deletion_recovery r
                     WHERE r.workspace_id = w.id
                       AND r.owner_user_id = $1
                       AND r.status = 'active'
                       AND r.expires_at > now()
                  )
                )
              )
            ORDER BY w.created_at ASC, w.id ASC`,
          [actor.userId],
        );
        return {
          user: {
            id: actor.userId,
            displayName: userRow.name,
            email: userRow.email,
          },
          workspaces: memberships.rows.map(toWorkspaceSummary),
        };
      },
    );
  }

  async getProfile(actor: IdentityActor): Promise<UserProfileView> {
    return withUnitOfWork(
      this.pool,
      {
        actorId: actor.userId,
        actorEmail: actor.email ? normalizeEmail(actor.email) : undefined,
        applicationRole: this.applicationRole,
      },
      async ({ client }) => {
        const result = await client.query<ProfileRow>(
          `SELECT u.id, u.name, u.email, u.email_verified,
                  COALESCE(p.locale, 'pt-BR') AS locale,
                  COALESCE(p.hide_values, false) AS hide_values,
                  COALESCE(p.version, 0) AS version
             FROM "user" u
             LEFT JOIN user_preference p ON p.user_id = u.id
            WHERE u.id = $1`,
          [actor.userId],
        );
        const row = result.rows[0];
        if (!row) throw new IdentityNotFoundError();
        return toUserProfile(row);
      },
    );
  }

  async updateProfile(
    actor: IdentityActor,
    input: unknown,
    expectedVersion: number,
    correlationId: string,
  ): Promise<UserProfileView> {
    const parsed = updateUserProfileSchema.parse(input);
    return withUnitOfWork(
      this.pool,
      {
        actorId: actor.userId,
        actorEmail: actor.email ? normalizeEmail(actor.email) : undefined,
        correlationId,
        applicationRole: this.applicationRole,
      },
      async ({ client }) => {
        // Serialize the first preference row creation as well as normal updates.
        // Without this lock, two v0 requests could both observe the missing row
        // and the loser would surface a raw unique-constraint error instead of 412.
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [actor.userId]);
        const current = await client.query<{
          name: string;
          locale: "pt-BR";
          hide_values: boolean;
          version: number | null;
        }>(
          `SELECT u.name,
                  COALESCE(p.locale, 'pt-BR') AS locale,
                  COALESCE(p.hide_values, false) AS hide_values,
                  p.version
             FROM "user" u
             LEFT JOIN user_preference p ON p.user_id = u.id
            WHERE u.id = $1`,
          [actor.userId],
        );
        const currentRow = current.rows[0];
        if (!currentRow) throw new IdentityNotFoundError();
        const currentVersion = Number(currentRow.version ?? 0);
        if (currentVersion !== expectedVersion)
          throw new IdentityVersionConflictError(currentVersion);
        await client.query(`UPDATE "user" SET name = $2, updated_at = now() WHERE id = $1`, [
          actor.userId,
          parsed.displayName,
        ]);
        await client.query(
          `INSERT INTO user_preference (user_id, locale, hide_values, version)
           VALUES ($1, $2, $3, 1)
           ON CONFLICT (user_id) DO UPDATE
             SET locale = EXCLUDED.locale,
                 hide_values = EXCLUDED.hide_values,
                 version = user_preference.version + 1,
                 updated_at = now()`,
          [actor.userId, parsed.locale, parsed.hideValues],
        );
        await writeAudit(client, {
          actorId: actor.userId,
          correlationId,
          action: "identity.profile_updated",
          targetId: actor.userId,
          targetType: "user",
          reason: "profile_fields_updated",
          beforeRedacted: redactProfileState(currentRow),
          afterRedacted: redactProfileState({
            name: parsed.displayName,
            locale: parsed.locale,
            hide_values: parsed.hideValues,
          }),
        });
        const result = await client.query<ProfileRow>(
          `SELECT u.id, u.name, u.email, u.email_verified,
                  p.locale, p.hide_values, p.version
             FROM "user" u
             JOIN user_preference p ON p.user_id = u.id
            WHERE u.id = $1`,
          [actor.userId],
        );
        const row = result.rows[0];
        if (!row) throw new IdentityNotFoundError();
        return toUserProfile(row);
      },
    );
  }

  async getWorkspacePreferences(scope: IdentityScope): Promise<WorkspacePreferencesView> {
    return this.withScoped(scope, async (client) => {
      const result = await client.query<WorkspacePreferencesRow>(
        `SELECT w.id, w.name, w.version, p.currency_code, p.timezone, p.safety_margin_minor
           FROM workspace w
           JOIN workspace_preference p ON p.workspace_id = w.id
          WHERE w.id = $1`,
        [scope.workspaceId],
      );
      const row = result.rows[0];
      if (!row) throw new IdentityNotFoundError();
      return toWorkspacePreferences(row);
    });
  }

  async updateWorkspacePreferences(
    scope: IdentityScope,
    input: unknown,
    expectedVersion: number,
  ): Promise<WorkspacePreferencesView> {
    assertRole(scope, "owner");
    const parsed = updateWorkspacePreferencesSchema.parse(input);
    if (!isValidTimeZone(parsed.timeZone)) {
      throw new IdentityConflictError("O fuso horário informado não é válido.");
    }
    return this.withScoped(scope, async (client) => {
      const result = await client.query<WorkspacePreferencesRow>(
        `SELECT w.id, w.name, w.version, p.currency_code, p.timezone, p.safety_margin_minor
           FROM workspace w
           JOIN workspace_preference p ON p.workspace_id = w.id
          WHERE w.id = $1
          FOR UPDATE OF w, p`,
        [scope.workspaceId],
      );
      const row = result.rows[0];
      if (!row) throw new IdentityNotFoundError();
      if (row.version !== expectedVersion) throw new IdentityVersionConflictError(row.version);
      if (row.currency_code !== parsed.currency) {
        const movement = await client.query<{ exists: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM ledger_event
              WHERE workspace_id = $1 AND status = 'published'
             UNION ALL
           SELECT 1 FROM finance_transaction
              WHERE workspace_id = $1
                AND state IN ('planned', 'partially_settled', 'posted')
              UNION ALL
           SELECT 1 FROM credit_card
              WHERE workspace_id = $1
           UNION ALL
           SELECT 1 FROM goal
              WHERE workspace_id = $1
           UNION ALL
           SELECT 1 FROM goal_reservation_movement
              WHERE workspace_id = $1
           ) AS exists`,
          [scope.workspaceId],
        );
        if (movement.rows[0]?.exists) {
          throw new IdentityConflictError(
            "A moeda não pode ser alterada após registrar movimentações, compromissos, cartões ou metas.",
          );
        }
      }
      await client.query(
        `UPDATE workspace
            SET name = $2, version = version + 1, updated_at = now()
          WHERE id = $1`,
        [scope.workspaceId, parsed.name],
      );
      await client.query(
        `UPDATE workspace_preference
            SET currency_code = $2, timezone = $3, safety_margin_minor = $4, updated_at = now()
          WHERE workspace_id = $1`,
        [scope.workspaceId, parsed.currency, parsed.timeZone, BigInt(parsed.safetyMarginMinor)],
      );
      await writeAudit(client, {
        actorId: scope.actor.userId,
        workspaceId: scope.workspaceId,
        correlationId: scope.correlationId,
        action: "workspace.preferences_updated",
        targetId: scope.workspaceId,
        reason: "workspace_preference_fields_updated",
        beforeRedacted: redactWorkspacePreferenceState(row),
        afterRedacted: redactWorkspacePreferenceState({
          name: parsed.name,
          currency_code: parsed.currency,
          timezone: parsed.timeZone,
          safety_margin_minor: BigInt(parsed.safetyMarginMinor),
        }),
      });
      return toWorkspacePreferences({
        ...row,
        name: parsed.name,
        currency_code: parsed.currency,
        timezone: parsed.timeZone,
        safety_margin_minor: BigInt(parsed.safetyMarginMinor),
        version: row.version + 1,
      });
    });
  }

  async resolveScope(
    actor: IdentityActor,
    workspaceId: string,
    correlationId = "",
  ): Promise<IdentityScope | null> {
    return withUnitOfWork(
      this.pool,
      {
        workspaceId,
        actorId: actor.userId,
        actorEmail: actor.email ? normalizeEmail(actor.email) : undefined,
        correlationId,
        applicationRole: this.applicationRole,
      },
      async ({ client }) => {
        const result = await client.query<{ role: WorkspaceRole }>(
          `SELECT m.role
             FROM membership m
             JOIN workspace w ON w.id = m.workspace_id
            WHERE m.workspace_id = $1 AND m.user_id = $2
              AND m.status = 'active' AND w.status = 'active'`,
          [workspaceId, actor.userId],
        );
        const role = result.rows[0]?.role;
        return role ? { actor, workspaceId, role, correlationId } : null;
      },
    );
  }

  async listMembers(scope: IdentityScope): Promise<WorkspaceMembersView> {
    assertRole(scope, "owner");
    return this.withScoped(scope, async (client) => {
      const result = await client.query<WorkspaceMemberRow>(
        `SELECT m.user_id, u.name AS display_name, u.email, m.role, m.status, m.version
           FROM membership m
           JOIN "user" u ON u.id = m.user_id
          WHERE m.workspace_id = $1
          ORDER BY CASE m.status WHEN 'active' THEN 0 WHEN 'recovery_only' THEN 1 ELSE 2 END,
                   u.name ASC, m.user_id ASC`,
        [scope.workspaceId],
      );
      return {
        members: result.rows.map((row) => ({
          userId: row.user_id,
          displayName: row.display_name,
          email: row.email,
          role: row.role,
          status: row.status,
          version: row.version,
        })),
      };
    });
  }

  async listInvitations(scope: IdentityScope): Promise<WorkspaceInvitationsView> {
    assertRole(scope, "owner");
    return this.withScoped(scope, async (client) => {
      await client.query(
        `UPDATE workspace_invitation
            SET status = 'expired', updated_at = now(), version = version + 1
          WHERE workspace_id = $1 AND status = 'pending' AND expires_at <= $2`,
        [scope.workspaceId, this.now()],
      );
      const result = await client.query<InvitationListRow>(
        `SELECT id, workspace_id, email, role, status, expires_at
           FROM workspace_invitation
          WHERE workspace_id = $1
          ORDER BY created_at DESC, id DESC`,
        [scope.workspaceId],
      );
      return {
        invitations: result.rows.map((row) => ({
          id: row.id,
          workspaceId: row.workspace_id,
          email: row.email,
          role: row.role,
          status: row.status,
          expiresAt: new Date(row.expires_at).toISOString(),
        })),
      };
    });
  }

  async createOnboarding(
    actor: IdentityActor,
    input: unknown,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<{ replayed: boolean; workspace: WorkspaceSummaryView }> {
    const parsed = onboardingSchema.parse(input);
    if (!isValidTimeZone(parsed.timeZone)) {
      throw new IdentityConflictError("O fuso horário informado não é válido.");
    }
    const initialBalanceMinor = parsed.includeInitialBalance
      ? BigInt(parsed.initialBalanceMinor)
      : 0n;
    const result = await withUnitOfWork(
      this.pool,
      {
        actorId: actor.userId,
        actorEmail: actor.email ? normalizeEmail(actor.email) : undefined,
        correlationId,
        applicationRole: this.applicationRole,
      },
      async ({ client }) =>
        executeIdempotent(client, {
          scope: `${actor.userId}:global:POST:/onboarding`,
          key: idempotencyKey,
          request: parsed,
          execute: async () => {
            await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
              actor.userId,
            ]);
            const existing = await client.query<WorkspaceSummaryRow>(
              `SELECT w.id, w.name, w.status, w.version, m.role, p.timezone, p.currency_code
                 FROM membership m
                 JOIN workspace w ON w.id = m.workspace_id
                 JOIN workspace_preference p ON p.workspace_id = w.id
                WHERE m.user_id = $1 AND m.role = 'owner' AND m.status = 'active'
                ORDER BY w.created_at ASC, w.id ASC
                LIMIT 1`,
              [actor.userId],
            );
            if (existing.rows[0]) {
              return {
                statusCode: 200,
                response: toWorkspaceSummary(existing.rows[0]) as unknown as JsonObject,
              };
            }

            const workspace = await client.query<{ id: string }>(`SELECT uuidv7() AS id`);
            const workspaceId = workspace.rows[0]?.id;
            if (!workspaceId) throw new Error("Could not allocate workspace ID");
            await setWorkspaceContext(client, workspaceId, actor);
            const inserted = await client.query<WorkspaceSummaryRow>(
              `INSERT INTO workspace (id, name) VALUES ($1, $2)
               RETURNING id, name, status, version`,
              [workspaceId, parsed.workspaceName],
            );
            await client.query(
              `INSERT INTO workspace_preference
                 (workspace_id, currency_code, timezone, initial_balance_minor, onboarding_completed_at)
               VALUES ($1, $2, $3, $4, now())`,
              [workspaceId, parsed.currency, parsed.timeZone, initialBalanceMinor],
            );
            await client.query(
              `INSERT INTO membership (workspace_id, user_id, role, status)
               VALUES ($1, $2, 'owner', 'active')`,
              [workspaceId, actor.userId],
            );
            await client.query(`UPDATE "user" SET name = $2, updated_at = now() WHERE id = $1`, [
              actor.userId,
              parsed.displayName,
            ]);
            await writeAudit(client, {
              actorId: actor.userId,
              workspaceId,
              correlationId,
              action: "workspace.onboarded",
              targetId: workspaceId,
              reason: "onboarding",
            });
            const row = inserted.rows[0];
            if (!row) throw new Error("Workspace insert did not return a row");
            return {
              statusCode: 201,
              response: {
                id: row.id,
                name: row.name,
                status: row.status,
                role: "owner",
                timezone: parsed.timeZone,
                currency_code: parsed.currency,
                version: row.version,
              },
            };
          },
        }),
    );
    return {
      replayed: result.replayed,
      workspace: {
        id: String(result.response.id),
        name: String(result.response.name),
        status: String(result.response.status) as WorkspaceSummaryView["status"],
        version: Number(result.response.version ?? 0),
        role: "owner",
        locale: "pt-BR",
        timeZone: String(result.response.timezone),
        currency: String(result.response.currency_code),
      },
    };
  }

  async createInvitation(
    scope: IdentityScope,
    input: unknown,
    idempotencyKey: string,
  ): Promise<{ replayed: boolean; invitation: InvitationView }> {
    const parsed = createInvitationSchema.parse(input);
    assertRole(scope, "owner");
    const email = normalizeEmail(parsed.email);
    let result: { replayed: boolean; statusCode: number; response: JsonValue };
    try {
      result = await this.withScoped(scope, async (client) =>
        executeIdempotent(client, {
          scope: `${scope.actor.userId}:${scope.workspaceId}:POST:/invitations`,
          key: idempotencyKey,
          request: parsed,
          execute: () => this.insertInvitation(client, scope, email, parsed.role),
        }),
      );
    } catch (error) {
      if (isPendingInvitationUniqueViolation(error)) {
        throw new IdentityConflictError("Já existe um convite pendente para este e-mail.");
      }
      throw error;
    }
    return { replayed: result.replayed, invitation: result.response as unknown as InvitationView };
  }

  async resendInvitation(
    scope: IdentityScope,
    invitationId: string,
    idempotencyKey: string,
  ): Promise<{ replayed: boolean; invitation: InvitationView }> {
    assertRole(scope, "owner");
    const result = await this.withScoped(scope, async (client) =>
      executeIdempotent(client, {
        scope: `${scope.actor.userId}:${scope.workspaceId}:POST:/invitations/${invitationId}/resend`,
        key: idempotencyKey,
        request: { invitationId },
        execute: async () => {
          await this.consumeInvitationRateLimit(client, scope, "resend");
          const old = await client.query<{
            email: string;
            role: "member" | "viewer";
            status: string;
          }>(
            `SELECT email, role, status FROM workspace_invitation
              WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
            [scope.workspaceId, invitationId],
          );
          const row = old.rows[0];
          if (row?.status !== "pending") throw new IdentityNotFoundError();
          await client.query(
            `UPDATE workspace_invitation SET status = 'revoked', updated_at = now(), version = version + 1
              WHERE workspace_id = $1 AND id = $2`,
            [scope.workspaceId, invitationId],
          );
          await this.deleteInvitationEmailArtifacts(client, scope.workspaceId, invitationId);
          return this.insertInvitation(client, scope, row.email, row.role, false);
        },
      }),
    );
    return { replayed: result.replayed, invitation: result.response as unknown as InvitationView };
  }

  async revokeInvitation(
    scope: IdentityScope,
    invitationId: string,
    idempotencyKey: string,
  ): Promise<{ replayed: boolean }> {
    assertRole(scope, "owner");
    const result = await this.withScoped(scope, async (client) =>
      executeIdempotent(client, {
        scope: `${scope.actor.userId}:${scope.workspaceId}:DELETE:/invitations/${invitationId}`,
        key: idempotencyKey,
        request: { invitationId },
        execute: async () => {
          const invitation = await client.query<{ status: string }>(
            `SELECT status FROM workspace_invitation
              WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
            [scope.workspaceId, invitationId],
          );
          const row = invitation.rows[0];
          if (!row) throw new IdentityNotFoundError();
          await this.deleteInvitationEmailArtifacts(client, scope.workspaceId, invitationId);
          if (row.status === "pending") {
            await client.query(
              `UPDATE workspace_invitation
                  SET status = 'revoked', updated_at = now(), version = version + 1
                WHERE workspace_id = $1 AND id = $2 AND status = 'pending'`,
              [scope.workspaceId, invitationId],
            );
            await writeAudit(client, {
              actorId: scope.actor.userId,
              workspaceId: scope.workspaceId,
              correlationId: scope.correlationId,
              action: "membership.invitation_revoked",
              targetId: invitationId,
            });
          }
          return { statusCode: 204, response: null };
        },
      }),
    );
    return { replayed: result.replayed };
  }

  async acceptInvitation(
    actor: IdentityActor,
    token: string,
    correlationId: string,
  ): Promise<WorkspaceSummaryView> {
    const parts = token.split(".");
    const workspaceId = parts[0];
    const invitationId = parts[1];
    const actorEmail = actor.email;
    if (!workspaceId || !invitationId || !actorEmail || !/^[0-9a-f-]{36}$/.test(workspaceId)) {
      throw new IdentityNotFoundError();
    }
    const accepted = await withUnitOfWork(
      this.pool,
      {
        workspaceId,
        actorId: actor.userId,
        actorEmail: normalizeEmail(actorEmail),
        correlationId,
        applicationRole: this.applicationRole,
      },
      async ({ client }) => {
        // Memberships are the first lock in every multi-membership identity
        // mutation. Acquire this actor row before the invitation's joined
        // workspace lock so acceptance cannot deadlock with deactivation.
        const current = await client.query<{ id: string; role: WorkspaceRole; status: string }>(
          `SELECT id, role, status FROM membership WHERE workspace_id = $1 AND user_id = $2 FOR UPDATE`,
          [workspaceId, actor.userId],
        );
        const result = await client.query<
          InvitationRow & {
            workspace_name: string;
            workspace_status: string;
            workspace_version: number;
            timezone: string;
            currency_code: string;
          }
        >(
          `SELECT i.*, w.name AS workspace_name, w.status AS workspace_status, w.version AS workspace_version, p.timezone, p.currency_code
             FROM workspace_invitation i
             JOIN workspace w ON w.id = i.workspace_id
             JOIN workspace_preference p ON p.workspace_id = w.id
            WHERE i.workspace_id = $1 AND i.id = $2
            FOR UPDATE`,
          [workspaceId, invitationId],
        );
        const invite = result.rows[0];
        if (!invite) throw new IdentityNotFoundError();
        if (invite.status !== "pending") {
          if (invite.status === "accepted" && invite.accepted_by === actor.userId) {
            return {
              summary: toWorkspaceSummary({
                id: workspaceId,
                name: invite.workspace_name,
                status: invite.workspace_status,
                role: invite.role,
                timezone: invite.timezone,
                currency_code: invite.currency_code,
                version: invite.workspace_version,
              }),
            };
          }
          throw new IdentityNotFoundError();
        }
        if (new Date(invite.expires_at).getTime() <= this.now().getTime()) {
          await client.query(
            `UPDATE workspace_invitation SET status = 'expired', updated_at = now() WHERE id = $1`,
            [invitationId],
          );
          return { expired: true as const };
        }
        const expectedHash = hashToken(token);
        if (invite.token_hash !== expectedHash || invite.email !== normalizeEmail(actorEmail)) {
          throw new IdentityNotFoundError();
        }
        if (invite.workspace_status !== "active")
          throw new IdentityConflictError("O espaço não está disponível.");
        await this.deleteInvitationEmailArtifacts(client, workspaceId, invitationId);
        if (current.rows[0]?.status === "active") {
          if (current.rows[0].role !== invite.role) {
            await client.query(
              `UPDATE membership SET role = $3, version = version + 1, updated_at = now() WHERE workspace_id = $1 AND user_id = $2`,
              [workspaceId, actor.userId, invite.role],
            );
          }
        } else if (current.rows[0]) {
          await client.query(
            `UPDATE membership SET role = $3, status = 'active', version = version + 1, updated_at = now() WHERE workspace_id = $1 AND user_id = $2`,
            [workspaceId, actor.userId, invite.role],
          );
        } else {
          await client.query(
            `INSERT INTO membership (workspace_id, user_id, role, status) VALUES ($1, $2, $3, 'active')`,
            [workspaceId, actor.userId, invite.role],
          );
        }
        await client.query(
          `UPDATE workspace_invitation SET status = 'accepted', accepted_by = $3, accepted_at = now(), updated_at = now(), version = version + 1 WHERE workspace_id = $1 AND id = $2`,
          [workspaceId, invitationId, actor.userId],
        );
        await writeAudit(client, {
          actorId: actor.userId,
          workspaceId,
          correlationId,
          action: "workspace.invitation_accepted",
          targetId: invitationId,
        });
        return {
          summary: toWorkspaceSummary({
            id: workspaceId,
            name: invite.workspace_name,
            status: invite.workspace_status,
            role: invite.role,
            timezone: invite.timezone,
            currency_code: invite.currency_code,
            version: invite.workspace_version,
          }),
        };
      },
    );
    if ("expired" in accepted) throw new IdentityNotFoundError();
    return accepted.summary;
  }

  async removeMember(
    scope: IdentityScope,
    userId: string,
    expectedVersion: number,
  ): Promise<{ version: number }> {
    assertRole(scope, "owner");
    return this.withScoped(
      scope,
      async (client) => {
        const locked = await lockMembershipsThenWorkspace(client, scope.workspaceId, [
          scope.actor.userId,
          userId,
        ]);
        assertLockedActiveMembership(locked.memberships, scope);
        assertLockedActiveWorkspace(locked.workspace);
        const row = locked.memberships.find((membership) => membership.user_id === userId);
        if (!row) throw new IdentityNotFoundError();
        if (row.version !== expectedVersion) throw new IdentityVersionConflictError(row.version);
        if (row.role === "owner")
          throw new IdentityConflictError("Transfira a propriedade antes de remover o owner.");
        if (row.status === "revoked") return { version: row.version };
        await client.query(
          `UPDATE membership SET status = 'revoked', version = version + 1, updated_at = now() WHERE workspace_id = $1 AND user_id = $2`,
          [scope.workspaceId, userId],
        );
        await writeAudit(client, {
          actorId: scope.actor.userId,
          workspaceId: scope.workspaceId,
          correlationId: scope.correlationId,
          action: "membership.revoked",
          targetId: userId,
        });
        return { version: row.version + 1 };
      },
      { lockMembership: false },
    );
  }

  async changeMemberRole(
    scope: IdentityScope,
    userId: string,
    input: unknown,
    expectedVersion: number,
  ): Promise<{ role: WorkspaceRole; version: number }> {
    assertRole(scope, "owner");
    const { role } = updateMembershipRoleSchema.parse(input);
    return this.withScoped(
      scope,
      async (client) => {
        const locked = await lockMembershipsThenWorkspace(client, scope.workspaceId, [
          scope.actor.userId,
          userId,
        ]);
        assertLockedActiveMembership(locked.memberships, scope);
        assertLockedActiveWorkspace(locked.workspace);
        const row = locked.memberships.find((membership) => membership.user_id === userId);
        if (row?.status !== "active") throw new IdentityNotFoundError();
        if (row.version !== expectedVersion) throw new IdentityVersionConflictError(row.version);
        if (row.role === "owner")
          throw new IdentityConflictError(
            "Use a transferência de propriedade para alterar o owner.",
          );
        await client.query(
          `UPDATE membership SET role = $3, version = version + 1, updated_at = now() WHERE workspace_id = $1 AND user_id = $2`,
          [scope.workspaceId, userId, role],
        );
        await writeAudit(client, {
          actorId: scope.actor.userId,
          workspaceId: scope.workspaceId,
          correlationId: scope.correlationId,
          action: "membership.role_changed",
          targetId: userId,
          reason: role,
        });
        return { role, version: row.version + 1 };
      },
      { lockMembership: false },
    );
  }

  async transferOwnership(
    scope: IdentityScope,
    userId: string,
    expectedVersion: number,
  ): Promise<{ version: number }> {
    assertRole(scope, "owner");
    return this.withScoped(
      scope,
      async (client) => {
        const locked = await lockMembershipsThenWorkspace(client, scope.workspaceId, [
          scope.actor.userId,
          userId,
        ]);
        assertLockedActiveMembership(locked.memberships, scope);
        const workspaceRow = assertLockedActiveWorkspace(locked.workspace);
        if (workspaceRow.version !== expectedVersion)
          throw new IdentityVersionConflictError(workspaceRow.version);
        if (userId === scope.actor.userId) return { version: workspaceRow.version };
        const target = locked.memberships.find((membership) => membership.user_id === userId);
        if (target?.status !== "active") throw new IdentityNotFoundError();
        await client.query(
          `UPDATE membership SET role = 'member', version = version + 1, updated_at = now() WHERE workspace_id = $1 AND user_id = $2`,
          [scope.workspaceId, scope.actor.userId],
        );
        await client.query(
          `UPDATE membership SET role = 'owner', version = version + 1, updated_at = now() WHERE workspace_id = $1 AND user_id = $2`,
          [scope.workspaceId, userId],
        );
        await client.query(
          `UPDATE workspace SET version = version + 1, updated_at = now() WHERE id = $1`,
          [scope.workspaceId],
        );
        await writeAudit(client, {
          actorId: scope.actor.userId,
          workspaceId: scope.workspaceId,
          correlationId: scope.correlationId,
          action: "membership.ownership_transferred",
          targetId: userId,
        });
        return { version: workspaceRow.version + 1 };
      },
      { lockMembership: false },
    );
  }

  async deactivateWorkspace(
    scope: IdentityScope,
    input: unknown,
    expectedVersion: number,
  ): Promise<{ recoveryUntil: string; version: number }> {
    assertRole(scope, "owner");
    if (!scope.actor.recentAuthentication) throw new IdentityRecentAuthError();
    const parsed = deactivateWorkspaceSchema.parse(input);
    return this.withScoped(
      scope,
      async (client) => {
        const locked = await lockMembershipsThenWorkspace(client, scope.workspaceId);
        assertLockedActiveMembership(locked.memberships, scope);
        const row = locked.workspace;
        if (!row) throw new IdentityNotFoundError();
        if (row.version !== expectedVersion) throw new IdentityVersionConflictError(row.version);
        if (row.status !== "active") throw new IdentityConflictError("O espaço já foi desativado.");
        if (row.name !== parsed.workspaceName)
          throw new IdentityConflictError("Confirme o nome atual do espaço para continuar.");
        const until = new Date(this.now().getTime() + RECOVERY_TTL_MS);
        await client.query(
          `UPDATE workspace SET status = 'deletion_pending', updated_at = now(), version = version + 1 WHERE id = $1`,
          [scope.workspaceId],
        );
        await client.query(
          `UPDATE membership SET status = 'recovery_only', version = version + 1, updated_at = now() WHERE workspace_id = $1 AND status = 'active'`,
          [scope.workspaceId],
        );
        await client.query(
          `UPDATE workspace_invitation SET status = 'revoked', updated_at = now(), version = version + 1 WHERE workspace_id = $1 AND status = 'pending'`,
          [scope.workspaceId],
        );
        await this.deleteInvitationEmailArtifacts(client, scope.workspaceId);
        await client.query(
          `UPDATE job SET state = 'cancelled', lease_until = NULL, lease_token = NULL, updated_at = now(), last_error = 'workspace_deletion_pending' WHERE workspace_id = $1 AND state IN ('pending', 'running', 'failed')`,
          [scope.workspaceId],
        );
        await client.query(
          `UPDATE outbox_event SET status = 'dead' WHERE workspace_id = $1 AND status = 'pending'`,
          [scope.workspaceId],
        );
        await client.query(
          `INSERT INTO workspace_deletion_recovery (workspace_id, owner_user_id, expires_at) VALUES ($1, $2, $3) ON CONFLICT (workspace_id) WHERE status = 'active' DO NOTHING`,
          [scope.workspaceId, scope.actor.userId, until],
        );
        await ensurePurgeJob(client, scope.workspaceId, until, scope.correlationId);
        await writeAudit(client, {
          actorId: scope.actor.userId,
          workspaceId: scope.workspaceId,
          correlationId: scope.correlationId,
          action: "workspace.deletion_requested",
          targetId: scope.workspaceId,
          reason: parsed.reason,
        });
        return { recoveryUntil: until.toISOString(), version: row.version + 1 };
      },
      { lockMembership: false },
    );
  }

  /** Retries a deactivation after the owner membership has entered recovery_only. */
  async retryDeactivation(
    actor: IdentityActor,
    workspaceId: string,
    input: unknown,
    correlationId: string,
    expectedVersion: number,
  ): Promise<{ recoveryUntil: string; version: number }> {
    if (!actor.recentAuthentication) throw new IdentityRecentAuthError();
    const parsed = deactivateWorkspaceSchema.parse(input);
    return withUnitOfWork(
      this.pool,
      {
        workspaceId,
        actorId: actor.userId,
        actorEmail: actor.email ? normalizeEmail(actor.email) : undefined,
        correlationId,
        applicationRole: this.applicationRole,
      },
      async ({ client }) => {
        // Purge and cancellation lock recovery before the workspace. Keep
        // retry in that same order so a concurrent retry cannot hold the
        // workspace while waiting for recovery.
        const recovery = await client.query<{ expires_at: Date }>(
          `SELECT expires_at
             FROM workspace_deletion_recovery
            WHERE workspace_id = $1 AND owner_user_id = $2 AND status = 'active'
            FOR UPDATE`,
          [workspaceId, actor.userId],
        );
        const workspace = await client.query<{ name: string; status: string; version: number }>(
          `SELECT name, status, version
             FROM workspace
            WHERE id = $1
            FOR UPDATE`,
          [workspaceId],
        );
        const recoveryRow = recovery.rows[0];
        const workspaceRow = workspace.rows[0];
        const row =
          recoveryRow && workspaceRow
            ? { ...workspaceRow, expires_at: recoveryRow.expires_at }
            : undefined;
        if (row?.status !== "deletion_pending") throw new IdentityNotFoundError();
        if (row.version === expectedVersion + 1) {
          if (row.name !== parsed.workspaceName)
            throw new IdentityConflictError("Confirme o nome atual do espaço para continuar.");
          await ensurePurgeJob(client, workspaceId, row.expires_at, correlationId);
          return { recoveryUntil: new Date(row.expires_at).toISOString(), version: row.version };
        }
        if (row.version !== expectedVersion) throw new IdentityVersionConflictError(row.version);
        if (row.name !== parsed.workspaceName)
          throw new IdentityConflictError("Confirme o nome atual do espaço para continuar.");
        await ensurePurgeJob(client, workspaceId, row.expires_at, correlationId);
        return { recoveryUntil: new Date(row.expires_at).toISOString(), version: row.version };
      },
    );
  }

  async getRecovery(
    actor: IdentityActor,
    workspaceId: string,
  ): Promise<{ status: string; recoveryUntil: string; version: number } | null> {
    return withUnitOfWork(
      this.pool,
      { workspaceId, actorId: actor.userId, applicationRole: this.applicationRole },
      async ({ client }) => {
        const result = await client.query<{ status: string; expires_at: Date; version: number }>(
          `SELECT r.status, r.expires_at, w.version
             FROM workspace_deletion_recovery r
             JOIN workspace w ON w.id = r.workspace_id
            WHERE r.workspace_id = $1 AND r.owner_user_id = $2 AND r.status = 'active'`,
          [workspaceId, actor.userId],
        );
        const row = result.rows[0];
        if (!row) return null;
        return {
          status:
            new Date(row.expires_at).getTime() <= this.now().getTime() ? "expired" : row.status,
          recoveryUntil: new Date(row.expires_at).toISOString(),
          version: row.version,
        };
      },
    );
  }

  async cancelDeactivation(
    actor: IdentityActor,
    workspaceId: string,
    correlationId: string,
    expectedVersion: number,
  ): Promise<{ version: number }> {
    return withUnitOfWork(
      this.pool,
      { workspaceId, actorId: actor.userId, applicationRole: this.applicationRole, correlationId },
      async ({ client }) => {
        // Purge locks the recovery row before deleting the workspace (and its
        // memberships). Acquire that row first here as well, then follow the
        // canonical membership→workspace order to avoid a late-cancel deadlock.
        const recovery = await client.query<{ status: string; expires_at: Date }>(
          `SELECT status, expires_at
             FROM workspace_deletion_recovery
            WHERE workspace_id = $1 AND owner_user_id = $2 AND status = 'active'
            FOR UPDATE`,
          [workspaceId, actor.userId],
        );
        const locked = await lockMembershipsThenWorkspace(client, workspaceId);
        const actorMembership = locked.memberships.find(
          (membership) => membership.user_id === actor.userId,
        );
        if (actorMembership?.role !== "owner" || actorMembership.status !== "recovery_only")
          throw new IdentityNotFoundError();
        const row =
          locked.workspace && recovery.rows[0]
            ? {
                workspaceStatus: locked.workspace.status,
                version: locked.workspace.version,
                expires_at: recovery.rows[0].expires_at,
              }
            : undefined;
        if (
          row?.workspaceStatus !== "deletion_pending" ||
          new Date(row.expires_at).getTime() <= this.now().getTime()
        )
          throw new IdentityNotFoundError();
        if (row.version !== expectedVersion) throw new IdentityVersionConflictError(row.version);
        await client.query(
          `UPDATE workspace SET status = 'active', updated_at = now(), version = version + 1 WHERE id = $1`,
          [workspaceId],
        );
        await client.query(
          `UPDATE job
              SET state = 'cancelled', lease_until = NULL, lease_token = NULL,
                  updated_at = now(), last_error = 'workspace_deletion_cancelled'
            WHERE workspace_id = $1
              AND job_type = 'workspace.purge' AND job_version = 1
              AND state IN ('pending', 'running', 'failed')`,
          [workspaceId],
        );
        await client.query(
          `UPDATE membership SET status = 'active', version = version + 1, updated_at = now() WHERE workspace_id = $1 AND status = 'recovery_only'`,
          [workspaceId],
        );
        await client.query(
          `UPDATE workspace_deletion_recovery SET status = 'canceled', canceled_at = now() WHERE workspace_id = $1 AND status = 'active'`,
          [workspaceId],
        );
        await writeAudit(client, {
          actorId: actor.userId,
          workspaceId,
          correlationId,
          action: "workspace.deletion_canceled",
          targetId: workspaceId,
        });
        return { version: row.version + 1 };
      },
    );
  }

  /** Called by the scheduled purge job after it has selected a due workspace. */
  async purgeWorkspace(
    workspaceId: string,
    correlationId: string,
    at = this.now(),
    preserveJobId?: string,
    preserveLeaseToken?: string,
  ): Promise<boolean> {
    return withUnitOfWork(
      this.pool,
      { workspaceId, correlationId, applicationRole: this.applicationRole },
      async ({ client }) => {
        const result = await client.query<{ owner_user_id: string; expires_at: Date }>(
          `SELECT owner_user_id, expires_at FROM workspace_deletion_recovery WHERE workspace_id = $1 AND status IN ('active', 'expired') FOR UPDATE`,
          [workspaceId],
        );
        const row = result.rows[0];
        if (!row || new Date(row.expires_at).getTime() > at.getTime()) return false;
        if (preserveJobId) {
          const lease = await client.query(
            `SELECT id FROM job
              WHERE id = $1 AND workspace_id = $2
                AND state = 'running' AND lease_token = $3
                AND lease_until > clock_timestamp()
              FOR UPDATE`,
            [preserveJobId, workspaceId, preserveLeaseToken ?? ""],
          );
          if (!lease.rows[0]) throw new JobLeaseLostError();
        }
        const deactivatedAt = new Date(row.expires_at.getTime() - RECOVERY_TTL_MS);
        await client.query(
          `INSERT INTO workspace_tombstone
             (workspace_id, pseudonymous_owner_hash, deactivated_at, purge_at, backup_expires_at, audit_purge_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (workspace_id) DO NOTHING`,
          [
            workspaceId,
            createHash("sha256").update(row.owner_user_id).digest("hex"),
            deactivatedAt,
            at,
            new Date(deactivatedAt.getTime() + BACKUP_RETENTION_MS),
            new Date(deactivatedAt.getTime() + AUDIT_RETENTION_MS),
          ],
        );
        await client.query(`SELECT app.detach_workspace_audit($1, $2)::int`, [
          workspaceId,
          new Date(deactivatedAt.getTime() + AUDIT_RETENTION_MS),
        ]);
        await client.query(
          `UPDATE job SET state = 'cancelled', lease_until = NULL, lease_token = NULL
             WHERE workspace_id = $1 AND ($2::uuid IS NULL OR id <> $2::uuid)`,
          [workspaceId, preserveJobId ?? null],
        );
        await client.query(`UPDATE outbox_event SET status = 'dead' WHERE workspace_id = $1`, [
          workspaceId,
        ]);
        await this.deleteInvitationEmailArtifacts(client, workspaceId);
        // Shopping purchase links are historical references to finance
        // transactions. Clear the reverse reference before the workspace
        // cascade so the scoped RESTRICT FK does not block authorized purge.
        await client.query(
          `UPDATE shopping_item SET expense_transaction_id = NULL
             WHERE workspace_id = $1 AND expense_transaction_id IS NOT NULL`,
          [workspaceId],
        );
        await client.query(`SELECT app.purge_workspace_goals($1)::int`, [workspaceId]);
        await client.query(`DELETE FROM workspace WHERE id = $1`, [workspaceId]);
        return true;
      },
    );
  }

  /**
   * Reaps lifecycle metadata only after the one-year cutoff. Both statements
   * are cutoff-based and therefore safe to retry after a worker interruption.
   */
  async purgeExpiredTombstones(
    at = this.now(),
  ): Promise<{ tombstones: number; auditEvents: number }> {
    return withUnitOfWork(
      this.pool,
      { applicationRole: this.applicationRole },
      async ({ client }) => {
        const audit = await client.query<{ count: number }>(
          `SELECT app.purge_expired_audit_events($1)::int AS count`,
          [at],
        );
        const tombstones = await client.query(
          `DELETE FROM workspace_tombstone WHERE audit_purge_at <= $1`,
          [at],
        );
        return {
          tombstones: tombstones.rowCount ?? 0,
          auditEvents: Number(audit.rows[0]?.count ?? 0),
        };
      },
    );
  }

  /** Worker registry for the durable purge job; the API only enqueues it. */
  createPurgeWorker(): PostgresJobWorker {
    return new PostgresJobWorker(
      this.pool,
      new Map([
        [
          "workspace.purge:1",
          async (job) => {
            if (!job.workspaceId) throw new Error("Purge job is missing a workspace");
            const purged = await this.purgeWorkspace(
              job.workspaceId,
              job.correlationId,
              this.now(),
              job.id,
              job.leaseToken,
            );
            if (!purged) throw new JobAuthorizationError();
          },
        ],
      ]),
      { applicationRole: this.applicationRole },
    );
  }

  private async insertInvitation(
    client: PoolClient,
    scope: IdentityScope,
    email: string,
    role: "member" | "viewer",
    enforceRateLimit = true,
  ) {
    if (enforceRateLimit) await this.consumeInvitationRateLimit(client, scope, "create");
    const existingUser = await client.query<{ id: string }>(
      `SELECT id FROM "user" WHERE lower(email) = $1`,
      [email],
    );
    if (existingUser.rows[0]) {
      const member = await client.query<{ status: string }>(
        `SELECT status FROM membership WHERE workspace_id = $1 AND user_id = $2`,
        [scope.workspaceId, existingUser.rows[0].id],
      );
      if (member.rows[0]?.status === "active")
        throw new IdentityConflictError("Essa pessoa já faz parte do espaço.");
    }
    await client.query(
      `UPDATE workspace_invitation SET status = 'revoked', updated_at = now(), version = version + 1 WHERE workspace_id = $1 AND email = $2 AND status = 'pending'`,
      [scope.workspaceId, email],
    );
    const idResult = await client.query<{ id: string }>(`SELECT uuidv7() AS id`);
    const id = idResult.rows[0]?.id;
    if (!id) throw new Error("Could not allocate invitation ID");
    const token = `${scope.workspaceId}.${id}.${randomBytes(24).toString("base64url")}`;
    const expiresAt = new Date(this.now().getTime() + INVITATION_TTL_MS);
    await client.query(
      `INSERT INTO workspace_invitation (id, workspace_id, email, token_hash, role, invited_by, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, scope.workspaceId, email, hashToken(token), role, scope.actor.userId, expiresAt],
    );
    await this.enqueueInvitationEmail(client, scope, id, email, token, expiresAt);
    await writeAudit(client, {
      actorId: scope.actor.userId,
      workspaceId: scope.workspaceId,
      correlationId: scope.correlationId,
      action: "membership.invitation_created",
      targetId: id,
    });
    return {
      statusCode: 201,
      response: {
        id,
        workspaceId: scope.workspaceId,
        email,
        role,
        status: "pending",
        expiresAt: expiresAt.toISOString(),
        inviteUrl: `${this.webOrigin}/invite/${encodeURIComponent(token)}`,
      } satisfies JsonObject,
    };
  }

  private async consumeInvitationRateLimit(
    client: PoolClient,
    scope: IdentityScope,
    action: "create" | "resend",
  ): Promise<void> {
    const now = this.now();
    const result = await client.query<{ attempts: number; window_started_at: Date }>(
      `INSERT INTO workspace_invitation_rate_limit
        (workspace_id, actor_user_id, action, window_started_at, attempts)
       VALUES ($1, $2, $3, $4, 1)
       ON CONFLICT (workspace_id, actor_user_id, action) DO UPDATE
         SET attempts = CASE
           WHEN workspace_invitation_rate_limit.window_started_at <= $4::timestamptz - interval '10 minutes'
             THEN 1
           ELSE workspace_invitation_rate_limit.attempts + 1
         END,
         window_started_at = CASE
           WHEN workspace_invitation_rate_limit.window_started_at <= $4::timestamptz - interval '10 minutes'
             THEN $4
           ELSE workspace_invitation_rate_limit.window_started_at
         END
       RETURNING attempts, window_started_at`,
      [scope.workspaceId, scope.actor.userId, action, now],
    );
    const row = result.rows[0];
    if (!row || row.attempts <= INVITATION_RATE_LIMIT) return;
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil(
        (new Date(row.window_started_at).getTime() + INVITATION_RATE_WINDOW_MS - now.getTime()) /
          1_000,
      ),
    );
    throw new InvitationRateLimitError(retryAfterSeconds);
  }

  private async enqueueInvitationEmail(
    client: PoolClient,
    scope: IdentityScope,
    invitationId: string,
    email: string,
    token: string,
    expiresAt: Date,
  ): Promise<void> {
    if (!this.authEmailSecret)
      throw new Error("BETTER_AUTH_SECRET is required for invitation email");
    const message: AuthEmailMessage = {
      kind: "invitation",
      userId: scope.actor.userId,
      email,
      url: `${this.webOrigin}/invite/${encodeURIComponent(token)}`,
      token,
      callbackUrl: null,
      correlationId: scope.correlationId,
      expiresAt,
      sourceId: invitationId,
    };
    const intent = await client.query<{ id: string }>(
      `INSERT INTO auth_email_intent
        (kind, actor_id, email_hash, callback_url, correlation_id, state, expires_at)
       VALUES ('invitation', $1, $2, '', $3, 'queued', $4)
       RETURNING id`,
      [
        scope.actor.userId,
        hashAuthEmailAddress(email, this.authEmailSecret),
        scope.correlationId,
        expiresAt,
      ],
    );
    const intentId = intent.rows[0]?.id;
    if (!intentId) throw new Error("Could not persist invitation email intent");
    await client.query(
      `INSERT INTO auth_email_outbox
        (intent_id, message_kind, source_id, encrypted_payload)
       VALUES ($1, 'invitation', $2, $3)`,
      [intentId, invitationId, encryptAuthEmailPayload(message, this.authEmailSecret)],
    );
  }

  private async deleteInvitationEmailArtifacts(
    client: PoolClient,
    workspaceId: string,
    invitationId?: string,
  ): Promise<void> {
    const deleted = await client.query<{ intent_id: string }>(
      `DELETE FROM auth_email_outbox o
        USING workspace_invitation i
       WHERE o.source_id = i.id::text
         AND i.workspace_id = $1
         AND ($2::uuid IS NULL OR i.id = $2::uuid)
       RETURNING o.intent_id`,
      [workspaceId, invitationId ?? null],
    );
    const intentIds = deleted.rows.map(({ intent_id }) => intent_id);
    if (intentIds.length > 0) {
      await client.query(`DELETE FROM auth_email_intent WHERE id = ANY($1::uuid[])`, [intentIds]);
    }
  }

  private async withScoped<T>(
    scope: IdentityScope,
    callback: (client: PoolClient) => Promise<T>,
    options: { lockMembership?: boolean } = {},
  ): Promise<T> {
    return withUnitOfWork(
      this.pool,
      {
        workspaceId: scope.workspaceId,
        actorId: scope.actor.userId,
        actorEmail: scope.actor.email ? normalizeEmail(scope.actor.email) : undefined,
        correlationId: scope.correlationId,
        applicationRole: this.applicationRole,
      },
      async ({ client }) => {
        await assertActiveMembership(client, scope, options.lockMembership ?? true);
        return callback(client);
      },
    );
  }
}

interface WorkspaceSummaryRow {
  id: string;
  name: string;
  status: string;
  role: WorkspaceRole;
  timezone: string;
  currency_code: string;
  version: number;
}

interface ProfileRow {
  id: string;
  name: string;
  email: string;
  email_verified: boolean;
  locale: "pt-BR";
  hide_values: boolean;
  version: number;
}

interface WorkspacePreferencesRow {
  id: string;
  name: string;
  version: number;
  currency_code: string;
  timezone: string;
  safety_margin_minor: bigint;
}

interface ProfileAuditState {
  name: string;
  locale: "pt-BR";
  hide_values: boolean;
}

interface WorkspacePreferenceAuditState {
  name: string;
  currency_code: string;
  timezone: string;
  safety_margin_minor: bigint | string;
}

interface InvitationRow {
  id: string;
  workspace_id: string;
  email: string;
  token_hash: string;
  role: "member" | "viewer";
  status: "pending" | "accepted" | "revoked" | "expired";
  expires_at: Date;
  accepted_by: string | null;
}

interface WorkspaceMemberRow {
  user_id: string;
  display_name: string;
  email: string;
  role: WorkspaceRole;
  status: "active" | "revoked" | "recovery_only";
  version: number;
}

interface InvitationListRow {
  id: string;
  workspace_id: string;
  email: string;
  role: "member" | "viewer";
  status: "pending" | "accepted" | "revoked" | "expired";
  expires_at: Date;
}

function toWorkspaceSummary(row: WorkspaceSummaryRow): WorkspaceSummaryView {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    locale: "pt-BR",
    timeZone: row.timezone,
    currency: row.currency_code,
    status: row.status as WorkspaceSummaryView["status"],
    version: row.version,
  };
}

function toUserProfile(row: ProfileRow): UserProfileView {
  return {
    userId: row.id,
    displayName: row.name,
    email: row.email,
    emailVerified: row.email_verified,
    locale: row.locale,
    hideValues: row.hide_values,
    version: row.version,
  };
}

function toWorkspacePreferences(row: WorkspacePreferencesRow): WorkspacePreferencesView {
  return {
    workspaceId: row.id,
    name: row.name,
    currency: row.currency_code,
    timeZone: row.timezone,
    safetyMarginMinor: row.safety_margin_minor.toString(),
    version: row.version,
  };
}

function redactProfileState(state: ProfileAuditState): JsonObject {
  return {
    display_name: "[redacted]",
    locale: state.locale,
    hide_values: state.hide_values,
  };
}

function redactWorkspacePreferenceState(state: WorkspacePreferenceAuditState): JsonObject {
  return {
    name: "[redacted]",
    currency: state.currency_code,
    time_zone: state.timezone,
    safety_margin_minor: "[redacted]",
  };
}

async function assertActiveMembership(
  client: PoolClient,
  scope: IdentityScope,
  lock = true,
): Promise<void> {
  const result = await client.query<{ role: WorkspaceRole }>(
    `SELECT m.role FROM membership m JOIN workspace w ON w.id = m.workspace_id WHERE m.workspace_id = $1 AND m.user_id = $2 AND m.status = 'active' AND w.status = 'active'${lock ? " FOR UPDATE OF m" : ""}`,
    [scope.workspaceId, scope.actor.userId],
  );
  if (!result.rows[0]) throw new IdentityNotFoundError();
  if (result.rows[0].role !== scope.role) throw new IdentityPermissionError();
}

interface LockedMembershipRow {
  user_id: string;
  role: WorkspaceRole;
  status: "active" | "revoked" | "recovery_only";
  version: number;
}

interface LockedWorkspaceRow {
  name: string;
  status: "active" | "deletion_pending" | "deactivated";
  version: number;
}

/**
 * Identity mutations that update multiple memberships use this order to avoid
 * acquiring a workspace lock while another transaction still owns a membership.
 * The sorted query is shared by ownership transfer and workspace deactivation.
 */
async function lockMembershipsThenWorkspace(
  client: PoolClient,
  workspaceId: string,
  userIds?: readonly string[],
): Promise<{ memberships: LockedMembershipRow[]; workspace: LockedWorkspaceRow | undefined }> {
  const sortedUserIds = userIds ? [...new Set(userIds)].sort() : undefined;
  const memberships = sortedUserIds
    ? await client.query<LockedMembershipRow>(
        `SELECT user_id, role, status, version
           FROM membership
          WHERE workspace_id = $1 AND user_id = ANY($2::text[])
          ORDER BY user_id ASC
          FOR UPDATE`,
        [workspaceId, sortedUserIds],
      )
    : await client.query<LockedMembershipRow>(
        `SELECT user_id, role, status, version
           FROM membership
          WHERE workspace_id = $1
          ORDER BY user_id ASC
          FOR UPDATE`,
        [workspaceId],
      );
  const workspace = await client.query<LockedWorkspaceRow>(
    `SELECT name, status, version FROM workspace WHERE id = $1 FOR UPDATE`,
    [workspaceId],
  );
  return { memberships: memberships.rows, workspace: workspace.rows[0] };
}

function assertLockedActiveMembership(
  memberships: readonly LockedMembershipRow[],
  scope: IdentityScope,
): LockedMembershipRow {
  const actor = memberships.find((membership) => membership.user_id === scope.actor.userId);
  if (actor?.status !== "active") throw new IdentityNotFoundError();
  if (actor.role !== scope.role) throw new IdentityPermissionError();
  return actor;
}

function assertLockedActiveWorkspace(
  workspace: LockedWorkspaceRow | undefined,
): LockedWorkspaceRow {
  if (workspace?.status !== "active") throw new IdentityNotFoundError();
  return workspace;
}

function assertRole(scope: IdentityScope, role: WorkspaceRole): void {
  if (scope.role !== role) throw new IdentityPermissionError();
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function isPendingInvitationUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505" &&
    "constraint" in error &&
    (error as { constraint?: unknown }).constraint === "workspace_invitation_pending_email_unique"
  );
}

async function ensurePurgeJob(
  client: PoolClient,
  workspaceId: string,
  purgeAt: Date,
  correlationId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO job
      (job_type, job_version, workspace_id, actor_id, required_capability,
       idempotency_key, payload, available_at, correlation_id)
     VALUES ('workspace.purge', 1, $1, NULL, 'system.purge', $2, $3::jsonb, $4, $5)
     ON CONFLICT (job_type, idempotency_key) DO UPDATE
       SET available_at = EXCLUDED.available_at,
           state = CASE WHEN job.state IN ('cancelled', 'failed') THEN 'pending' ELSE job.state END,
           last_error = NULL,
           updated_at = now()`,
    [
      workspaceId,
      `workspace-purge:${workspaceId}`,
      JSON.stringify({ workspaceId, purgeAt: purgeAt.toISOString() }),
      purgeAt,
      correlationId || "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    ],
  );
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
    return true;
  } catch {
    return false;
  }
}

async function setWorkspaceContext(
  client: PoolClient,
  workspaceId: string,
  actor: IdentityActor,
): Promise<void> {
  await client.query(
    `SELECT set_config('app.workspace_id', $1, true), set_config('app.actor_id', $2, true), set_config('app.actor_email', $3, true)`,
    [workspaceId, actor.userId, actor.email ? normalizeEmail(actor.email) : ""],
  );
}

async function writeAudit(
  client: PoolClient,
  input: {
    actorId: string;
    workspaceId?: string;
    correlationId: string;
    action: string;
    targetId?: string;
    targetType?: "workspace" | "user";
    reason?: string;
    beforeRedacted?: JsonObject;
    afterRedacted?: JsonObject;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_event
      (category, action, actor_id, workspace_id, target_type, target_id, origin, correlation_id, result, reason, before_redacted, after_redacted, retention_until)
     VALUES ('identity', $1, $2, $3, $4, $5, 'api', $6, 'success', $7, $8::jsonb, $9::jsonb, now() + interval '365 days')`,
    [
      input.action,
      input.actorId,
      input.workspaceId,
      input.targetType ?? (input.workspaceId ? "workspace" : "user"),
      input.targetId ?? input.workspaceId ?? input.actorId,
      input.correlationId || "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      input.reason ?? null,
      input.beforeRedacted ?? null,
      input.afterRedacted ?? null,
    ],
  );
}
