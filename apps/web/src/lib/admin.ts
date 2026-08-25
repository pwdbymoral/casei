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

export class AdminAdapterError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(
    status: number,
    code = "internal_error",
    message = "Não foi possível concluir a ação.",
  ) {
    super(message);
    this.name = "AdminAdapterError";
    this.status = status;
    this.code = code;
  }
}

type RequestOptions = RequestInit & { idempotencyKey?: string; stepUpToken?: string };

async function adminRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const origin = configuredApiOrigin();
  if (!origin) throw new AdminAdapterError(0, "offline", "A origem da API não foi configurada.");
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (options.idempotencyKey) headers.set("Idempotency-Key", options.idempotencyKey);
  if (options.stepUpToken) headers.set("X-Admin-Step-Up", options.stepUpToken);
  const response = await fetch(`${origin}${path}`, { ...options, headers, credentials: "include" });
  if (response.status === 204) return undefined as T;
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
    );
  }
  return body as T;
}

export function createAdminCommandKey(action: string): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : String(Date.now());
  return `admin-${action}-${random}`.slice(0, 128).padEnd(16, "0");
}

export const authenticatedAdminAdapter = {
  async completeStepUp(
    method: "totp" | "backup_code",
    code: string,
  ): Promise<{ token: string; expiresInSeconds: number }> {
    return adminRequest("/v1/admin/step-up", {
      method: "POST",
      body: JSON.stringify({ method, code }),
    });
  },
  async searchAccounts(query: string, limit = 50): Promise<AdminAccountList> {
    const params = new URLSearchParams({ query, limit: String(limit) });
    return adminRequest<AdminAccountList>(`/v1/admin/accounts?${params.toString()}`);
  },
  async getAccount(userId: string): Promise<AdminAccountDetail> {
    return adminRequest<AdminAccountDetail>(`/v1/admin/accounts/${encodeURIComponent(userId)}`);
  },
  async suspend(
    userId: string,
    reason: string,
    commandKey?: string,
    stepUpToken?: string,
  ): Promise<AdminAccountDetail> {
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
  ): Promise<AdminAccountDetail> {
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
  ): Promise<AdminAccountDetail> {
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
  ): Promise<void> {
    await adminRequest<void>(
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
  ): Promise<void> {
    await adminRequest<void>(
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
  ): Promise<void> {
    await adminRequest<void>(`/v1/admin/accounts/${encodeURIComponent(userId)}/recovery/resend`, {
      method: "POST",
      body: JSON.stringify({ reason }),
      idempotencyKey: commandKey ?? createAdminCommandKey("recovery"),
      stepUpToken,
    });
  },
};
