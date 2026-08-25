import { AdminPolicyError } from "./admin-policy.js";
import type { AdminAuthPort } from "./admin-service.js";

/** Reuses Better Auth's normal email flows; this port never receives or creates tokens. */
export class BetterAuthAdminAuthPort implements AdminAuthPort {
  constructor(
    private readonly handler: (request: Request) => Response | Promise<Response>,
    private readonly apiOrigin: string,
    private readonly webOrigin: string,
  ) {}

  sendVerificationEmail(email: string, idempotencyKey?: string): Promise<void> {
    return this.send(
      "/api/auth/send-verification-email",
      {
        email,
        callbackURL: this.webOrigin,
      },
      idempotencyKey,
    );
  }

  sendPasswordReset(email: string, idempotencyKey?: string): Promise<void> {
    return this.send(
      "/api/auth/request-password-reset",
      {
        email,
        redirectTo: `${this.webOrigin}/reset-password`,
      },
      idempotencyKey,
    );
  }

  async verifyStepUp(input: {
    method: "totp" | "backup_code";
    code: string;
    headers: Headers;
  }): Promise<void> {
    const path =
      input.method === "totp"
        ? "/api/auth/two-factor/verify-totp"
        : "/api/auth/two-factor/verify-backup-code";
    const headers = new Headers(input.headers);
    headers.set("content-type", "application/json");
    headers.set("origin", this.webOrigin);
    const response = await this.handler(
      new Request(`${this.apiOrigin}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ code: input.code, trustDevice: false }),
      }),
    );
    if (!response.ok) throw new AdminPolicyError("step_up_required");
  }

  async startTwoFactorEnrollment(input: {
    password: string;
    headers: Headers;
  }): Promise<{ totpURI: string; backupCodes: string[] }> {
    const headers = new Headers(input.headers);
    headers.set("content-type", "application/json");
    headers.set("origin", this.webOrigin);
    const response = await this.handler(
      new Request(`${this.apiOrigin}/api/auth/two-factor/enable`, {
        method: "POST",
        headers,
        body: JSON.stringify({ password: input.password, issuer: "Casei" }),
      }),
    );
    if (!response.ok) throw new AdminPolicyError("step_up_required");
    const body = (await response.json().catch(() => null)) as {
      totpURI?: unknown;
      backupCodes?: unknown;
    } | null;
    if (
      !body ||
      typeof body.totpURI !== "string" ||
      !Array.isArray(body.backupCodes) ||
      body.backupCodes.some((code) => typeof code !== "string")
    ) {
      throw new AdminPolicyError("step_up_required");
    }
    return { totpURI: body.totpURI, backupCodes: body.backupCodes };
  }

  async verifyTwoFactorEnrollment(input: {
    code: string;
    headers: Headers;
  }): Promise<{ setCookies: string[] }> {
    const headers = new Headers(input.headers);
    headers.set("content-type", "application/json");
    headers.set("origin", this.webOrigin);
    const response = await this.handler(
      new Request(`${this.apiOrigin}/api/auth/two-factor/verify-totp`, {
        method: "POST",
        headers,
        body: JSON.stringify({ code: input.code, trustDevice: false }),
      }),
    );
    if (!response.ok) throw new AdminPolicyError("step_up_required");
    return { setCookies: responseSetCookies(response) };
  }

  private async send(
    path: string,
    body: Record<string, string>,
    idempotencyKey?: string,
  ): Promise<void> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      Origin: this.webOrigin,
    };
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    const response = await this.handler(
      new Request(`${this.apiOrigin}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
    );
    if (!response.ok) throw new Error("Better Auth email flow failed");
  }
}

function responseSetCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const cookies = headers.getSetCookie?.();
  if (cookies && cookies.length > 0) return cookies;
  const combined = response.headers.get("set-cookie");
  return combined ? [combined] : [];
}
