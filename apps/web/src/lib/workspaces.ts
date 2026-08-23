export type WorkspaceRole = "owner" | "member" | "viewer";

export type WorkspaceSummary = {
  id: string;
  name: string;
  role: WorkspaceRole;
  locale: "pt-BR";
  timeZone: string;
  status: "active" | "deletion_pending" | "deactivated";
  version: number;
};

export type WorkspaceUser = {
  id: string;
  displayName: string;
  email: string;
};

export type WorkspaceSession = {
  user: WorkspaceUser;
  workspaces: WorkspaceSummary[];
  activeWorkspaceId: string | null;
};

/**
 * Adapter boundary for the authenticated workspace session.
 *
 * AUTH-002/003 will replace the fixture with the typed HTTP client. The shell
 * deliberately depends on this small boundary instead of assuming an API
 * response shape that is not implemented yet.
 */
export interface WorkspaceAdapter {
  getSession(): Promise<WorkspaceSession>;
  switchWorkspace(workspaceId: string): Promise<WorkspaceSession>;
  signOut?(): Promise<void>;
}

export type WorkspaceMember = {
  userId: string;
  displayName: string;
  email: string;
  role: WorkspaceRole;
  status: "active" | "revoked" | "recovery_only";
  version: number;
};

export type WorkspaceInvitation = {
  id: string;
  workspaceId: string;
  email: string;
  role: "member" | "viewer";
  status: "pending" | "accepted" | "revoked" | "expired";
  expiresAt: string;
  inviteUrl?: string;
};

export interface WorkspaceManagementAdapter {
  listMembers(workspaceId: string): Promise<WorkspaceMember[]>;
  listInvitations(workspaceId: string): Promise<WorkspaceInvitation[]>;
  createInvitation(
    workspaceId: string,
    input: { email: string; role: "member" | "viewer" },
    idempotencyKey?: string,
  ): Promise<WorkspaceInvitation>;
  resendInvitation(
    workspaceId: string,
    invitationId: string,
    idempotencyKey?: string,
  ): Promise<WorkspaceInvitation>;
  revokeInvitation(
    workspaceId: string,
    invitationId: string,
    idempotencyKey?: string,
  ): Promise<void>;
  removeMember(workspaceId: string, userId: string, version: number): Promise<void>;
  changeMemberRole(
    workspaceId: string,
    userId: string,
    role: "member" | "viewer",
    version: number,
  ): Promise<void>;
  transferOwnership(workspaceId: string, userId: string, version: number): Promise<void>;
  deactivateWorkspace(
    workspaceId: string,
    input: { workspaceName: string; reason: string },
    version: number,
  ): Promise<{ recoveryUntil: string }>;
}

export type WorkspaceSessionErrorCode = "unauthenticated" | "permission_denied" | "offline";

export class WorkspaceSessionError extends Error {
  readonly code: WorkspaceSessionErrorCode;

  constructor(code: WorkspaceSessionErrorCode, message = "Sua sessão não está disponível.") {
    super(message);
    this.name = "WorkspaceSessionError";
    this.code = code;
  }
}

export class WorkspaceManagementError extends Error {
  constructor(
    readonly status: number,
    message = "Não foi possível atualizar a gestão do espaço.",
  ) {
    super(message);
    this.name = "WorkspaceManagementError";
  }
}

/** Production-safe default until AUTH-002 provides the authenticated adapter. */
export const unauthenticatedWorkspaceAdapter: WorkspaceAdapter = {
  async getSession() {
    throw new WorkspaceSessionError("unauthenticated");
  },
  async switchWorkspace() {
    throw new WorkspaceSessionError("unauthenticated");
  },
};

function apiOrigin(): string {
  return (process.env.NEXT_PUBLIC_CASEI_API_ORIGIN ?? "http://localhost:3001").replace(/\/$/, "");
}

async function workspaceRequest(): Promise<WorkspaceSession> {
  let response: Response;
  try {
    response = await fetch(`${apiOrigin()}/v1/me/workspaces`, {
      credentials: "include",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
  } catch {
    throw new WorkspaceSessionError("offline", "Não foi possível conectar ao Casei.");
  }
  if (response.status === 401) throw new WorkspaceSessionError("unauthenticated");
  if (response.status === 403) throw new WorkspaceSessionError("permission_denied");
  if (!response.ok)
    throw new WorkspaceSessionError("offline", "Não foi possível carregar seus espaços.");
  const body = (await response.json()) as Omit<WorkspaceSession, "activeWorkspaceId">;
  return withStoredWorkspace({
    ...body,
    workspaces: body.workspaces.map((workspace) => ({
      ...workspace,
      status: workspace.status ?? "active",
      version: workspace.version ?? 0,
    })),
    activeWorkspaceId: null,
  });
}

/** Real browser adapter. It never fabricates a workspace when the API denies the session. */
export const authenticatedWorkspaceAdapter: WorkspaceAdapter = {
  getSession: workspaceRequest,
  async switchWorkspace(workspaceId) {
    const session = await workspaceRequest();
    if (!session.workspaces.some((workspace) => workspace.id === workspaceId)) {
      throw new WorkspaceSessionError(
        "permission_denied",
        "Este espaço não está disponível para você.",
      );
    }
    persistWorkspaceId(workspaceId);
    return { ...session, activeWorkspaceId: workspaceId };
  },
  async signOut() {
    const response = await fetch(`${apiOrigin()}/api/auth/sign-out`, {
      method: "POST",
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!response.ok && response.status !== 401) {
      throw new Error("Não foi possível encerrar a sessão.");
    }
  },
};

async function managementRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${apiOrigin()}${path}`, {
      ...init,
      credentials: "include",
      headers: {
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch {
    throw new WorkspaceSessionError("offline", "Não foi possível conectar ao Casei.");
  }
  if (response.status === 401) throw new WorkspaceSessionError("unauthenticated");
  if (response.status === 403) throw new WorkspaceSessionError("permission_denied");
  if (response.status === 404) throw new WorkspaceSessionError("permission_denied");
  if (!response.ok) throw new WorkspaceManagementError(response.status);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function managementIdempotencyKey(prefix: string): string {
  return `${prefix}-${globalThis.crypto.randomUUID()}`;
}

/** Typed HTTP boundary for owner-only member and invitation management. */
export const authenticatedWorkspaceManagementAdapter: WorkspaceManagementAdapter = {
  async listMembers(workspaceId) {
    const response = await managementRequest<{ members: WorkspaceMember[] }>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/members`,
    );
    return response.members;
  },
  async listInvitations(workspaceId) {
    const response = await managementRequest<{ invitations: WorkspaceInvitation[] }>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/invitations`,
    );
    return response.invitations;
  },
  async createInvitation(workspaceId, input, idempotencyKey) {
    return managementRequest<WorkspaceInvitation>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/invitations`,
      {
        method: "POST",
        headers: {
          "Idempotency-Key": idempotencyKey ?? managementIdempotencyKey("invite"),
        },
        body: JSON.stringify(input),
      },
    );
  },
  async resendInvitation(workspaceId, invitationId, idempotencyKey) {
    return managementRequest<WorkspaceInvitation>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/invitations/${encodeURIComponent(invitationId)}/resend`,
      {
        method: "POST",
        headers: {
          "Idempotency-Key": idempotencyKey ?? managementIdempotencyKey("resend-invite"),
        },
      },
    );
  },
  async revokeInvitation(workspaceId, invitationId, idempotencyKey) {
    await managementRequest<void>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/invitations/${encodeURIComponent(invitationId)}`,
      {
        method: "DELETE",
        headers: {
          "Idempotency-Key": idempotencyKey ?? managementIdempotencyKey("revoke-invite"),
        },
      },
    );
  },
  async removeMember(workspaceId, userId, version) {
    await managementRequest<void>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}`,
      { method: "DELETE", headers: { "If-Match": `"v${version}"` } },
    );
  },
  async changeMemberRole(workspaceId, userId, role, version) {
    await managementRequest<{ userId: string; role: WorkspaceRole }>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}`,
      { method: "PATCH", headers: { "If-Match": `"v${version}"` }, body: JSON.stringify({ role }) },
    );
  },
  async transferOwnership(workspaceId, userId, version) {
    await managementRequest<void>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/ownership/transfer`,
      {
        method: "POST",
        headers: { "If-Match": `"v${version}"` },
        body: JSON.stringify({ userId }),
      },
    );
  },
  async deactivateWorkspace(workspaceId, input, version) {
    return managementRequest<{ recoveryUntil: string }>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/deactivation`,
      {
        method: "POST",
        headers: { "If-Match": `"v${version}"` },
        body: JSON.stringify(input),
      },
    );
  },
};

export interface PlatformAdminSession {
  userId: string;
  displayName: string;
  role: "platform_admin" | "platform_support";
}

export interface PlatformAdminSessionPort {
  getSession(): Promise<PlatformAdminSession | null>;
}

/** Never grants an administrative shell by default. Replace only at the auth boundary. */
export const unauthenticatedPlatformAdminSessionPort: PlatformAdminSessionPort = {
  async getSession() {
    return null;
  },
};

export function clearWorkspaceClientState(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(activeWorkspaceStorageKey);
  for (const key of Object.keys(window.sessionStorage)) {
    if (key.startsWith("casei:workspace:")) window.sessionStorage.removeItem(key);
  }
}

const fixtureSession: WorkspaceSession = {
  user: {
    id: "user_fixture_marina",
    displayName: "Marina Souza",
    email: "marina@example.com",
  },
  workspaces: [
    {
      id: "019b5d9e-3c12-7a01-8d47-7b5b5dd7a201",
      name: "Casa Horizonte",
      role: "owner",
      locale: "pt-BR",
      timeZone: "America/Fortaleza",
      status: "active",
      version: 0,
    },
    {
      id: "019b5d9e-3c12-7a02-8d47-7b5b5dd7a202",
      name: "Studio 14",
      role: "member",
      locale: "pt-BR",
      timeZone: "America/Sao_Paulo",
      status: "active",
      version: 0,
    },
  ],
  activeWorkspaceId: "019b5d9e-3c12-7a01-8d47-7b5b5dd7a201",
};

const activeWorkspaceStorageKey = "casei:active-workspace:v1";

function getStoredWorkspaceId(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(activeWorkspaceStorageKey);
}

function withStoredWorkspace(session: WorkspaceSession): WorkspaceSession {
  const storedId = getStoredWorkspaceId();
  const storedWorkspace = session.workspaces.find(({ id }) => id === storedId);
  const activeWorkspaceId =
    (storedWorkspace?.status === "active" ? storedWorkspace.id : undefined) ??
    session.workspaces.find(({ status }) => status === "active")?.id ??
    session.activeWorkspaceId ??
    session.workspaces[0]?.id ??
    null;

  return { ...session, activeWorkspaceId };
}

function persistWorkspaceId(workspaceId: string): void {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(activeWorkspaceStorageKey, workspaceId);
  }
}

/** Temporary adapter used until the authenticated workspace endpoints land. */
export const fixtureWorkspaceAdapter: WorkspaceAdapter = {
  async getSession() {
    await new Promise((resolve) => setTimeout(resolve, 180));
    return withStoredWorkspace(fixtureSession);
  },
  async switchWorkspace(workspaceId) {
    const workspace = fixtureSession.workspaces.find(({ id }) => id === workspaceId);
    if (!workspace) {
      throw new Error("Não foi possível encontrar este espaço.");
    }
    persistWorkspaceId(workspaceId);
    return { ...fixtureSession, activeWorkspaceId: workspaceId };
  },
};

export function getActiveWorkspace(session: WorkspaceSession): WorkspaceSummary | null {
  return session.workspaces.find(({ id }) => id === session.activeWorkspaceId) ?? null;
}
