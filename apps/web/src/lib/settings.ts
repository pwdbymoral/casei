import {
  WorkspaceManagementError,
  WorkspaceSessionError,
  type WorkspaceSessionErrorCode,
} from "./workspaces";

export type UserProfile = {
  userId: string;
  displayName: string;
  email: string;
  emailVerified: boolean;
  locale: "pt-BR";
  hideValues: boolean;
  version: number;
};

export type WorkspacePreferences = {
  workspaceId: string;
  name: string;
  currency: string;
  timeZone: string;
  safetyMarginMinor: string;
  version: number;
};

function apiOrigin(): string {
  return (process.env.NEXT_PUBLIC_CASEI_API_ORIGIN ?? "http://localhost:3001").replace(/\/$/, "");
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
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
  if (response.status === 403 || response.status === 404) {
    throw new WorkspaceSessionError("permission_denied");
  }
  if (!response.ok) throw new WorkspaceManagementError(response.status);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const authenticatedSettingsAdapter = {
  getProfile() {
    return request<UserProfile>("/v1/me/profile");
  },
  updateProfile(
    input: Omit<UserProfile, "userId" | "email" | "emailVerified" | "version">,
    version: number,
  ) {
    return request<UserProfile>("/v1/me/profile", {
      method: "PATCH",
      headers: { "If-Match": `"v${version}"` },
      body: JSON.stringify(input),
    });
  },
  getWorkspacePreferences(workspaceId: string) {
    return request<WorkspacePreferences>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/preferences`,
    );
  },
  updateWorkspacePreferences(
    workspaceId: string,
    input: Omit<WorkspacePreferences, "workspaceId" | "version">,
    version: number,
  ) {
    return request<WorkspacePreferences>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/preferences`,
      {
        method: "PATCH",
        headers: { "If-Match": `"v${version}"` },
        body: JSON.stringify(input),
      },
    );
  },
  changePassword(input: { currentPassword: string; newPassword: string }) {
    return request<{ status: boolean }>("/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ ...input, revokeOtherSessions: false }),
    });
  },
  changeEmail(newEmail: string) {
    return request<{ status: boolean; message?: string }>("/api/auth/change-email", {
      method: "POST",
      body: JSON.stringify({ newEmail, callbackURL: "/app/settings" }),
    });
  },
  sendVerificationEmail(email: string) {
    return request<{ status: boolean }>("/api/auth/send-verification-email", {
      method: "POST",
      body: JSON.stringify({ email, callbackURL: "/app/settings" }),
    });
  },
};

export function settingsErrorMessage(error: unknown): string {
  if (error instanceof WorkspaceManagementError && error.status === 412) {
    return "Esta configuração mudou em outra aba. Recarregue antes de salvar novamente.";
  }
  if (error instanceof WorkspaceSessionError) {
    const messages: Record<WorkspaceSessionErrorCode, string> = {
      unauthenticated: "Sua sessão expirou. Entre novamente para continuar.",
      permission_denied: "Você não tem permissão para alterar esta configuração.",
      offline: "Sem conexão. Suas alterações continuam neste formulário; tente novamente.",
    };
    return messages[error.code];
  }
  return error instanceof Error ? error.message : "Não foi possível salvar a configuração.";
}
