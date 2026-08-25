import { describe, expect, it } from "vitest";

import { BetterAuthAdminAuthPort } from "../src/admin-auth-port.js";

describe("BetterAuthAdminAuthPort", () => {
  it("maps invalid step-up responses to a safe policy error", async () => {
    const port = new BetterAuthAdminAuthPort(
      async () =>
        new Response(JSON.stringify({ message: "secret provider details" }), { status: 400 }),
      "http://api.test",
      "http://web.test",
    );
    await expect(
      port.verifyStepUp({ method: "totp", code: "000000", headers: new Headers() }),
    ).rejects.toMatchObject({ code: "step_up_required" });
  });

  it("forwards the command key to the auth email outbox boundary", async () => {
    let request: Request | undefined;
    const port = new BetterAuthAdminAuthPort(
      async (incoming) => {
        request = incoming;
        return new Response(null, { status: 200 });
      },
      "http://api.test",
      "http://web.test",
    );
    await port.sendVerificationEmail("ada@example.com", "admin-command-key-0001");
    expect(request?.headers.get("Idempotency-Key")).toBe("admin-command-key-0001");
  });

  it("validates the enrollment payload before returning it", async () => {
    const port = new BetterAuthAdminAuthPort(
      async () =>
        new Response(JSON.stringify({ totpURI: "otpauth://totp/Casei", backupCodes: ["one"] }), {
          status: 200,
        }),
      "http://api.test",
      "http://web.test",
    );
    await expect(
      port.startTwoFactorEnrollment({ password: "password", headers: new Headers() }),
    ).resolves.toEqual({ totpURI: "otpauth://totp/Casei", backupCodes: ["one"] });
  });
});
