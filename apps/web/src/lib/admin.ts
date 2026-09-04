import { configuredApiOrigin } from "./api-origin";

export type PlatformRole = "platform_admin" | "platform_support";
export type PlatformAccountStatus = "active" | "suspended";

export type AdminAccountSummary = {
  userId: string;
  displayName: string;
  email: string;
  role: PlatformRole | null;
  status: PlatformAccountStatus;
  createdAt: string;
  lastActivityAt: string | null;
  workspaceCount: number;
  activeSessionCount: number;
};

export type AdminSession = {
  id: string;
  createdAt: string;
  updatedAt: string | null;
  expiresAt: string;
  ipAddress: string | null;
  userAgent: string | null;
};

export type AdminAccountDetail = AdminAccountSummary & {
  workspaces: Array<{ id: string; name: string; status: string }>;
  sessions: AdminSession[];
};

export type AdminAccountList = {
  items: AdminAccountSummary[];
  page: { nextCursor: string | null; hasMore: boolean };
};

export type AdminJobType = "data.import" | "recurrence.expand";
export type AdminJobState = "pending" | "running" | "succeeded" | "failed" | "dead" | "cancelled";
export type AdminJob = {
  id: string;
  type: AdminJobType;
  version: number;
  workspaceId: string | null;
  actorId: string | null;
  requiredCapability: string | null;
  state: AdminJobState;
  attempts: number;
  availableAt: string;
  leaseUntil: string | null;
  correlationId: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  retryable: boolean;
};
export type AdminJobList = {
  items: AdminJob[];
  page: { nextCursor: string | null; hasMore: boolean };
  health: Record<AdminJobState, number>;
};
export type AdminAuditEvent = {
  id: string;
  actorId: string | null;
  targetId: string | null;
  action: string;
  occurredAt: string;
  origin: string;
  correlationId: string;
  ipAddress: string | null;
  endpoint: string | null;
  result: "success" | "failure";
  reason: string;
};
export type AdminAuditList = {
  items: AdminAuditEvent[];
  page: { nextCursor: string | null; hasMore: boolean };
};

export class AdminAdapterError extends Error {
  readonly status: number;
  readonly code: string;
  readonly correlationId: string | null;

  constructor(
    status: number,
    code = "internal_error",
    message = "Não foi possível concluir a ação.",
    correlationId: string | null = null,
  ) {
    super(message);
    this.name = "AdminAdapterError";
    this.status = status;
    this.code = code;
    this.correlationId = correlationId;
  }
}

type RequestOptions = RequestInit & { idempotencyKey?: string; stepUpToken?: string };
export type AdminAdapterResult<T> = { data: T; correlationId: string | null };

async function adminRequest<T>(
  path: string,
  options: RequestOptions = {},
): Promise<AdminAdapterResult<T>> {
  const origin = configuredApiOrigin();
  if (!origin) throw new AdminAdapterError(0, "offline", "A origem da API não foi configurada.");
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (options.idempotencyKey) headers.set("Idempotency-Key", options.idempotencyKey);
  if (options.stepUpToken) headers.set("X-Admin-Step-Up", options.stepUpToken);
  const response = await fetch(`${origin}${path}`, { ...options, headers, credentials: "include" });
  const correlationId = response.headers.get("X-Correlation-ID");
  if (response.status === 204) return { data: undefined as T, correlationId };
  const body = (await response.json().catch(() => null)) as
    | { error?: { code?: string; message?: string } }
    | T
    | null;
  if (!response.ok) {
    const error = body && typeof body === "object" && "error" in body ? body.error : undefined;
    throw new AdminAdapterError(
      response.status,
      error?.code ?? "internal_error",
      error?.message ?? "Não foi possível concluir a ação.",
      correlationId,
    );
  }
  return { data: body as T, correlationId };
}

export function createAdminCommandKey(action: string): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : String(Date.now());
  return `admin-${action}-${random}`.slice(0, 128).padEnd(16, "0");
}

export const authenticatedAdminAdapter = {
  async startTwoFactorEnrollment(
    password: string,
  ): Promise<AdminAdapterResult<{ totpURI: string; backupCodes: string[] }>> {
    return adminRequest<{ totpURI: string; backupCodes: string[] }>("/v1/admin/two-factor/enroll", {
      method: "POST",
      body: JSON.stringify({ password }),
    });
  },
  async verifyTwoFactorEnrollment(code: string): Promise<AdminAdapterResult<void>> {
    return adminRequest<void>("/v1/admin/two-factor/verify", {
      method: "POST",
      body: JSON.stringify({ code }),
    });
  },
  async completeStepUp(
    method: "totp" | "backup_code",
    code: string,
  ): Promise<AdminAdapterResult<{ token: string; expiresInSeconds: number }>> {
    return adminRequest<{ token: string; expiresInSeconds: number }>("/v1/admin/step-up", {
      method: "POST",
      body: JSON.stringify({ method, code }),
    });
  },
  async searchAccounts(query: string, limit = 50): Promise<AdminAdapterResult<AdminAccountList>> {
    const params = new URLSearchParams({ query, limit: String(limit) });
    return adminRequest<AdminAccountList>(`/v1/admin/accounts?${params.toString()}`);
  },
  async searchJobs(
    filters: { type?: AdminJobType; state?: AdminJobState; limit?: number; cursor?: string } = {},
  ): Promise<AdminAdapterResult<AdminJobList>> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters))
      if (value !== undefined) params.set(key, String(value));
    return adminRequest<AdminJobList>(`/v1/admin/jobs?${params.toString()}`);
  },
  async retryJob(
    jobId: string,
    reason: string,
    commandKey?: string,
    stepUpToken?: string,
  ): Promise<AdminAdapterResult<AdminJob>> {
    return adminRequest<AdminJob>(`/v1/admin/jobs/${encodeURIComponent(jobId)}/retry`, {
      method: "POST",
      body: JSON.stringify({ reason }),
      idempotencyKey: commandKey ?? createAdminCommandKey("job-retry"),
      stepUpToken,
    });
  },
  async searchAudit(
    filters: {
      actorId?: string;
      targetId?: string;
      action?: string;
      from?: string;
      to?: string;
      limit?: number;
      cursor?: string;
    } = {},
  ): Promise<AdminAdapterResult<AdminAuditList>> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters))
      if (value !== undefined) params.set(key, String(value));
    return adminRequest<AdminAuditList>(`/v1/admin/audit?${params.toString()}`);
  },
  async getAccount(userId: string): Promise<AdminAdapterResult<AdminAccountDetail>> {
    return adminRequest<AdminAccountDetail>(`/v1/admin/accounts/${encodeURIComponent(userId)}`);
  },
  async suspend(
    userId: string,
    reason: string,
    commandKey?: string,
    stepUpToken?: string,
  ): Promise<AdminAdapterResult<AdminAccountDetail>> {
    return adminRequest<AdminAccountDetail>(
      `/v1/admin/accounts/${encodeURIComponent(userId)}/suspend`,
      {
        method: "POST",
        body: JSON.stringify({ reason }),
        idempotencyKey: commandKey ?? createAdminCommandKey("suspend"),
        stepUpToken,
      },
    );
  },
  async reactivate(
    userId: string,
    reason: string,
    commandKey?: string,
    stepUpToken?: string,
  ): Promise<AdminAdapterResult<AdminAccountDetail>> {
    return adminRequest<AdminAccountDetail>(
      `/v1/admin/accounts/${encodeURIComponent(userId)}/reactivate`,
      {
        method: "POST",
        body: JSON.stringify({ reason }),
        idempotencyKey: commandKey ?? createAdminCommandKey("reactivate"),
        stepUpToken,
      },
    );
  },
  async changeRole(
    userId: string,
    role: PlatformRole | null,
    reason: string,
    commandKey?: string,
    stepUpToken?: string,
  ): Promise<AdminAdapterResult<AdminAccountDetail>> {
    return adminRequest<AdminAccountDetail>(
      `/v1/admin/accounts/${encodeURIComponent(userId)}/platform-role`,
      {
        method: "PATCH",
        body: JSON.stringify({ role, reason }),
        idempotencyKey: commandKey ?? createAdminCommandKey("role"),
        stepUpToken,
      },
    );
  },
  async revokeSession(
    userId: string,
    sessionId: string,
    reason: string,
    commandKey?: string,
    stepUpToken?: string,
  ): Promise<AdminAdapterResult<void>> {
    return adminRequest<void>(
      `/v1/admin/accounts/${encodeURIComponent(userId)}/sessions/${encodeURIComponent(sessionId)}`,
      {
        method: "DELETE",
        body: JSON.stringify({ reason }),
        idempotencyKey: commandKey ?? createAdminCommandKey("session"),
        stepUpToken,
      },
    );
  },
  async resendVerification(
    userId: string,
    reason: string,
    commandKey?: string,
    stepUpToken?: string,
  ): Promise<AdminAdapterResult<void>> {
    return adminRequest<void>(
      `/v1/admin/accounts/${encodeURIComponent(userId)}/verification/resend`,
      {
        method: "POST",
        body: JSON.stringify({ reason }),
        idempotencyKey: commandKey ?? createAdminCommandKey("verify"),
        stepUpToken,
      },
    );
  },
  async resendRecovery(
    userId: string,
    reason: string,
    commandKey?: string,
    stepUpToken?: string,
  ): Promise<AdminAdapterResult<void>> {
    return adminRequest<void>(`/v1/admin/accounts/${encodeURIComponent(userId)}/recovery/resend`, {
      method: "POST",
      body: JSON.stringify({ reason }),
      idempotencyKey: commandKey ?? createAdminCommandKey("recovery"),
      stepUpToken,
    });
  },
};
