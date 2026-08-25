import type { AdminAuthPort } from "./admin-service.js";

/** Reuses Better Auth's normal email flows; this port never receives or creates tokens. */
export class BetterAuthAdminAuthPort implements AdminAuthPort {
  constructor(
    private readonly handler: (request: Request) => Response | Promise<Response>,
    private readonly apiOrigin: string,
    private readonly webOrigin: string,
  ) {}

  sendVerificationEmail(email: string): Promise<void> {
    return this.send("/api/auth/send-verification-email", {
      email,
      callbackURL: this.webOrigin,
    });
  }

  sendPasswordReset(email: string): Promise<void> {
    return this.send("/api/auth/request-password-reset", {
      email,
      redirectTo: `${this.webOrigin}/reset-password`,
    });
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
    if (!response.ok) throw new Error("Better Auth step-up verification failed");
  }

  private async send(path: string, body: Record<string, string>): Promise<void> {
    const response = await this.handler(
      new Request(`${this.apiOrigin}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Origin: this.webOrigin,
        },
        body: JSON.stringify(body),
      }),
    );
    if (!response.ok) throw new Error("Better Auth email flow failed");
  }
}
