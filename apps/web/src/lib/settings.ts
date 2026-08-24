import { requireApiOrigin as requireConfiguredApiOrigin } from "./api-origin";
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

export type WorkspacePreferencesDraft = Omit<WorkspacePreferences, "workspaceId" | "version">;

/** Captures the exact values shown in the confirmation preview. */
export function snapshotPreferencesDraft(
  draft: WorkspacePreferencesDraft,
): WorkspacePreferencesDraft {
  return {
    name: draft.name,
    currency: draft.currency,
    timeZone: draft.timeZone,
    safetyMarginMinor: draft.safetyMarginMinor,
  };
}

export function preferenceChangeSummary(
  current: WorkspacePreferences,
  next: WorkspacePreferencesDraft,
): string[] {
  const changes: string[] = [];
  if (current.name !== next.name) changes.push(`Nome: ${current.name} → ${next.name}`);
  if (current.currency !== next.currency) {
    changes.push(
      `Moeda: ${current.currency} → ${next.currency} (confirme que não há movimentos pendentes)`,
    );
  }
  if (current.timeZone !== next.timeZone) {
    changes.push(
      `Fuso horário: ${current.timeZone} → ${next.timeZone} (datas futuras serão exibidas neste fuso)`,
    );
  }
  if (current.safetyMarginMinor !== next.safetyMarginMinor) {
    changes.push(
      `Margem de segurança: ${current.safetyMarginMinor} → ${next.safetyMarginMinor} centavos`,
    );
  }
  return changes.length > 0 ? changes : ["Nenhuma alteração será feita."];
}

function requireWebOrigin(): string {
  const configured = process.env.NEXT_PUBLIC_CASEI_WEB_ORIGIN?.trim();
  if (!configured) throw new Error("NEXT_PUBLIC_CASEI_WEB_ORIGIN não está configurada.");
  try {
    const url = new URL(configured);
    if (!(["http:", "https:"] as string[]).includes(url.protocol) || url.username || url.password) {
      throw new Error("origem inválida");
    }
    return url.origin;
  } catch {
    throw new Error("NEXT_PUBLIC_CASEI_WEB_ORIGIN deve ser uma origem HTTP(S) absoluta.");
  }
}

export function requireApiOrigin(): string {
  return requireConfiguredApiOrigin();
}

function settingsCallbackUrl(): string {
  return `${requireWebOrigin()}/app/settings`;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const origin = requireApiOrigin();
  let response: Response;
  try {
    response = await fetch(`${origin}${path}`, {
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
      body: JSON.stringify({ newEmail, callbackURL: settingsCallbackUrl() }),
    });
  },
  sendVerificationEmail(email: string) {
    return request<{ status: boolean }>("/api/auth/send-verification-email", {
      method: "POST",
      body: JSON.stringify({ email, callbackURL: settingsCallbackUrl() }),
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
