import { memoryAdapter } from "better-auth/adapters/memory";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { createAuth } from "../src/auth.js";
import {
  CaptureTransactionalEmailPort,
  dispatchQueuedAuthEmail,
  MemoryAuthEmailIntentStore,
} from "../src/auth-email.js";

const apiOrigin = "http://localhost:3001";
const webOrigin = "http://localhost:3000";
const authSecret = "test-secret-that-is-longer-than-thirty-two-characters";

function memoryDatabase() {
  return { user: [], session: [], account: [], verification: [] };
}

function fixture() {
  const emailPort = new CaptureTransactionalEmailPort();
  const emailStore = new MemoryAuthEmailIntentStore();
  const auth = createAuth({
    database: memoryAdapter(memoryDatabase()),
    emailPort,
    emailStore,
    baseURL: apiOrigin,
    trustedOrigins: [apiOrigin, webOrigin],
    secret: authSecret,
  });
  const app = createApp(undefined, {
    authHandler: (request) => auth.handler(request),
    authOrigins: [apiOrigin, webOrigin],
  });
  return { app, auth, emailPort, emailStore };
}

async function authRequest(
  app: ReturnType<typeof createApp>,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Origin", webOrigin);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return app.request(`${apiOrigin}/api/auth/${path}`, { ...init, headers });
}

function jsonBody(value: unknown): RequestInit {
  return { method: "POST", body: JSON.stringify(value) };
}

function sessionCookie(response: Response): string {
  const cookie = response.headers
    .get("set-cookie")
    ?.match(/better-auth\.session_token=([^;]+)/)?.[1];
  if (!cookie) throw new Error("expected session cookie");
  return `better-auth.session_token=${cookie}`;
}

describe("AUTH-001 identidade", () => {
  it("cadastra, captura verificação, verifica e impede enumeração do token", async () => {
    const { app, emailPort } = fixture();
    const response = await authRequest(
      app,
      "sign-up/email",
      jsonBody({
        name: "Ada Lovelace",
        email: "ada@example.com",
        password: "correct-horse-battery",
        callbackURL: `${webOrigin}/welcome`,
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      token: null,
      user: { email: "ada@example.com", emailVerified: false },
    });
    expect(JSON.stringify(body)).not.toContain(emailPort.messages[0]?.token ?? "missing-token");
    expect(emailPort.messages).toHaveLength(1);
    const verificationMessage = emailPort.messages[0];
    if (!verificationMessage) throw new Error("expected verification message");
    expect(verificationMessage).toMatchObject({ kind: "verification", email: "ada@example.com" });

    const verification = await app.request(verificationMessage.url, {
      headers: { Origin: webOrigin },
    });
    expect(verification.status).toBe(302);
    expect(verification.headers.get("location")).toBe(`${webOrigin}/welcome`);
  });

  it("faz login, lista, revoga sessão e encerra a sessão atual", async () => {
    const { app, emailPort } = fixture();
    await authRequest(
      app,
      "sign-up/email",
      jsonBody({
        name: "Ada Lovelace",
        email: "ada@example.com",
        password: "correct-horse-battery",
        callbackURL: `${webOrigin}/welcome`,
      }),
    );
    const verificationMessage = emailPort.messages[0];
    if (!verificationMessage) throw new Error("expected verification message");
    await app.request(verificationMessage.url, { headers: { Origin: webOrigin } });

    const login = await authRequest(
      app,
      "sign-in/email",
      jsonBody({ email: "ada@example.com", password: "correct-horse-battery" }),
    );
    expect(login.status).toBe(200);
    const cookie = sessionCookie(login);

    const sessions = await authRequest(app, "list-sessions", { headers: { Cookie: cookie } });
    expect(sessions.status).toBe(200);
    const listed = await sessions.json();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ userId: expect.any(String) });

    const revoked = await authRequest(app, "revoke-session", {
      ...jsonBody({ token: listed[0].token }),
      headers: { Cookie: cookie },
    });
    expect(revoked.status).toBe(200);

    const current = await authRequest(app, "get-session", { headers: { Cookie: cookie } });
    expect(current.status).toBe(200);
    await expect(current.json()).resolves.toBeNull();

    const secondLogin = await authRequest(
      app,
      "sign-in/email",
      jsonBody({ email: "ada@example.com", password: "correct-horse-battery" }),
    );
    const secondCookie = sessionCookie(secondLogin);
    const logout = await authRequest(app, "sign-out", {
      method: "POST",
      headers: { Cookie: secondCookie },
    });
    expect(logout.status).toBe(200);
    const afterLogout = await authRequest(app, "get-session", {
      headers: { Cookie: secondCookie },
    });
    await expect(afterLogout.json()).resolves.toBeNull();
  });

  it("usa a mesma resposta de recuperação para e-mail existente e inexistente", async () => {
    const { app, emailPort } = fixture();
    const unknown = await authRequest(
      app,
      "request-password-reset",
      jsonBody({ email: "unknown@example.com", redirectTo: `${webOrigin}/reset` }),
    );
    expect(unknown.status).toBe(200);
    const unknownBody = await unknown.json();

    await authRequest(
      app,
      "sign-up/email",
      jsonBody({
        name: "Ada Lovelace",
        email: "ada@example.com",
        password: "correct-horse-battery",
        callbackURL: `${webOrigin}/welcome`,
      }),
    );
    const verificationMessage = emailPort.messages[0];
    if (!verificationMessage) throw new Error("expected verification message");
    await app.request(verificationMessage.url, { headers: { Origin: webOrigin } });
    const known = await authRequest(
      app,
      "request-password-reset",
      jsonBody({ email: "ada@example.com", redirectTo: `${webOrigin}/reset` }),
    );
    expect(known.status).toBe(200);
    await expect(known.json()).resolves.toEqual(unknownBody);
    expect(emailPort.messages).toHaveLength(2);
    const resetMessage = emailPort.messages[1];
    if (!resetMessage) throw new Error("expected reset message");
    expect(resetMessage).toMatchObject({
      kind: "password_reset",
      email: "ada@example.com",
    });

    const resetLink = await app.request(resetMessage.url, { headers: { Origin: webOrigin } });
    expect(resetLink.status).toBe(302);
    const location = resetLink.headers.get("location");
    if (!location) throw new Error("expected reset callback location");
    const token = new URL(location).searchParams.get("token");
    if (!token) throw new Error("expected reset token");
    const reset = await authRequest(
      app,
      "reset-password",
      jsonBody({ token, newPassword: "new-correct-horse" }),
    );
    expect(reset.status).toBe(200);
    const login = await authRequest(
      app,
      "sign-in/email",
      jsonBody({ email: "ada@example.com", password: "new-correct-horse" }),
    );
    expect(login.status).toBe(200);
  });

  it("rejeita callback externo e aplica rate limit no cadastro", async () => {
    const { app, emailPort } = fixture();
    const invalid = await authRequest(
      app,
      "sign-up/email",
      jsonBody({
        name: "Ada Lovelace",
        email: "ada@example.com",
        password: "correct-horse-battery",
        callbackURL: "https://evil.example/steal",
      }),
    );
    expect(invalid.status).toBe(403);
    expect(emailPort.messages).toHaveLength(0);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await authRequest(
        app,
        "sign-up/email",
        jsonBody({
          name: "Ada Lovelace",
          email: `ada-${attempt}@example.com`,
          password: "correct-horse-battery",
          callbackURL: `${webOrigin}/welcome`,
        }),
      );
    }
    const limited = await authRequest(
      app,
      "sign-up/email",
      jsonBody({
        name: "Ada Lovelace",
        email: "ada-over-limit@example.com",
        password: "correct-horse-battery",
        callbackURL: `${webOrigin}/welcome`,
      }),
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
  });

  it("persiste a intent antes da entrega e não duplica reprocessamento", async () => {
    const store = new MemoryAuthEmailIntentStore();
    const transport = new CaptureTransactionalEmailPort();
    const message = {
      kind: "verification" as const,
      userId: "user-1",
      email: "ada@example.com",
      url: `${apiOrigin}/api/auth/verify-email?token=opaque&callbackURL=${encodeURIComponent(`${webOrigin}/welcome`)}`,
      token: "opaque",
      callbackUrl: `${webOrigin}/welcome`,
      correlationId: "01J6Q3B5M8G7T5N4R3Q2P1WXYZ",
      expiresAt: new Date(Date.now() + 60_000),
      sourceId: "verification:opaque",
    };
    await dispatchQueuedAuthEmail(store, transport, message);
    await dispatchQueuedAuthEmail(store, transport, message);
    expect(transport.messages).toHaveLength(1);
    expect(store.states[0]).toMatchObject({ state: "sent" });
  });
});
