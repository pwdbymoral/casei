import { cookies } from "next/headers";

import { requireApiOrigin } from "./api-origin";
import type { PlatformAdminSession, PlatformAdminSessionPort } from "./workspaces";

/** Server-only adapter: forwards the incoming Better Auth cookie and never
 * falls back to a fixture or client-provided role. */
export const authenticatedPlatformAdminSessionPort: PlatformAdminSessionPort = {
  async getSession(): Promise<PlatformAdminSession | null> {
    const cookieHeader = (await cookies()).toString();
    let origin: string;
    try {
      origin = requireApiOrigin();
    } catch {
      return null;
    }
    const response = await fetch(`${origin}/v1/admin/session`, {
      headers: cookieHeader ? { cookie: cookieHeader } : undefined,
      cache: "no-store",
    });
    if (response.status === 401 || response.status === 403) return null;
    if (!response.ok) throw new Error("Não foi possível validar a sessão administrativa.");
    return (await response.json()) as PlatformAdminSession;
  },
};
