export type WorkspaceRole = "owner" | "member" | "viewer";

export type WorkspaceSummary = {
  id: string;
  name: string;
  role: WorkspaceRole;
  locale: "pt-BR";
  timeZone: string;
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

/** Production-safe default until AUTH-002 provides the authenticated adapter. */
export const unauthenticatedWorkspaceAdapter: WorkspaceAdapter = {
  async getSession() {
    throw new WorkspaceSessionError("unauthenticated");
  },
  async switchWorkspace() {
    throw new WorkspaceSessionError("unauthenticated");
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
    },
    {
      id: "019b5d9e-3c12-7a02-8d47-7b5b5dd7a202",
      name: "Studio 14",
      role: "member",
      locale: "pt-BR",
      timeZone: "America/Sao_Paulo",
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
  const activeWorkspaceId = session.workspaces.some(({ id }) => id === storedId)
    ? storedId
    : (session.activeWorkspaceId ?? session.workspaces[0]?.id ?? null);

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
