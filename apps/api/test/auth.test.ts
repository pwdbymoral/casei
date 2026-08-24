import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryAdapter } from "better-auth/adapters/memory";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { createAuth, defaultAuthIpAddressOptions, defaultTrustedProxies } from "../src/auth.js";
import {
  type AuthEmailEnqueueFailure,
  CaptureAuthEmailEnqueueFailureSink,
  CaptureTransactionalEmailPort,
  FileAuthEmailEnqueueFailureSink,
  MemoryAuthEmailIntentStore,
  processPendingAuthEmails,
  queueAuthEmail,
  recoverAuthEmailEnqueueFailure,
  recoverDurableAuthEmailEnqueueFailures,
  smtpConfigFromEnvironment,
  type TransactionalEmailPort,
  verifyTransactionalEmailPort,
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
    trustedProxies: ["127.0.0.1"],
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
    const { app, emailPort, emailStore } = fixture();
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
    expect(emailPort.messages).toHaveLength(0);
    expect(await processPendingAuthEmails(emailStore, emailPort)).toBe(1);
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
    expect(verificationMessage.sourceId).toMatch(/^[a-f0-9]{64}$/);
    expect(verificationMessage.sourceId).not.toContain(verificationMessage.token);

    const verification = await app.request(verificationMessage.url, {
      headers: { Origin: webOrigin },
    });
    expect(verification.status).toBe(302);
    expect(verification.headers.get("location")).toBe(`${webOrigin}/welcome`);
  });

  it("faz login, lista, revoga sessão e encerra a sessão atual", async () => {
    const { app, emailPort, emailStore } = fixture();
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
    expect(await processPendingAuthEmails(emailStore, emailPort)).toBe(1);
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

  it("habilita mudança de e-mail com confirmação na origem PWA", async () => {
    const { app, emailPort, emailStore } = fixture();
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
    expect(await processPendingAuthEmails(emailStore, emailPort)).toBe(1);
    const verificationMessage = emailPort.messages[0];
    if (!verificationMessage) throw new Error("expected verification message");
    await app.request(verificationMessage.url, { headers: { Origin: webOrigin } });

    const login = await authRequest(
      app,
      "sign-in/email",
      jsonBody({ email: "ada@example.com", password: "correct-horse-battery" }),
    );
    const cookie = sessionCookie(login);
    const changed = await authRequest(app, "change-email", {
      ...jsonBody({
        newEmail: "ada.new@example.com",
        callbackURL: `${webOrigin}/app/settings`,
      }),
      headers: { Cookie: cookie },
    });
    expect(changed.status).toBe(200);
    expect(await processPendingAuthEmails(emailStore, emailPort)).toBe(1);
    const confirmation = emailPort.messages[1];
    if (!confirmation) throw new Error("expected email change confirmation");
    expect(confirmation).toMatchObject({ kind: "verification", email: "ada@example.com" });
    expect(confirmation.url).toContain(encodeURIComponent(`${webOrigin}/app/settings`));
    expect(confirmation.url).not.toContain(encodeURIComponent(`${apiOrigin}/app/settings`));
  });

  it("usa a mesma resposta de recuperação para e-mail existente e inexistente", async () => {
    const { app, emailPort, emailStore } = fixture();
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
    expect(await processPendingAuthEmails(emailStore, emailPort)).toBe(1);
    const verificationMessage = emailPort.messages[0];
    if (!verificationMessage) throw new Error("expected verification message");
    await app.request(verificationMessage.url, { headers: { Origin: webOrigin } });
    const known = await authRequest(
      app,
      "request-password-reset",
      jsonBody({ email: "ada@example.com", redirectTo: `${webOrigin}/reset` }),
    );
    expect(known.status).toBe(200);
    expect(await processPendingAuthEmails(emailStore, emailPort)).toBe(1);
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

  it("usa callback relativo padrão quando o cadastro não informa callbackURL", async () => {
    const { app, emailPort, emailStore } = fixture();
    const response = await authRequest(
      app,
      "sign-up/email",
      jsonBody({
        name: "Ada Lovelace",
        email: "ada-default@example.com",
        password: "correct-horse-battery",
      }),
    );

    expect(response.status).toBe(200);
    expect(await processPendingAuthEmails(emailStore, emailPort)).toBe(1);
    expect(emailPort.messages[0]).toMatchObject({ callbackUrl: "/" });
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

  it("persiste a intent, recupera falha e não duplica reprocessamento", async () => {
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
    await Promise.all([queueAuthEmail(store, message), queueAuthEmail(store, message)]);
    expect(transport.messages).toHaveLength(0);
    expect(
      await processPendingAuthEmails(
        store,
        {
          send: async () => {
            throw new Error("temporary SMTP failure");
          },
        },
        {
          backoffBaseMs: 0,
        },
      ),
    ).toBe(0);
    expect(store.states[0]).toMatchObject({ state: "failed" });
    const concurrentDeliveries = await Promise.all([
      processPendingAuthEmails(store, transport, { backoffBaseMs: 0 }),
      processPendingAuthEmails(store, transport, { backoffBaseMs: 0 }),
    ]);
    expect(concurrentDeliveries.reduce((total, value) => total + value, 0)).toBe(1);
    await processPendingAuthEmails(store, transport);
    expect(transport.messages).toHaveLength(1);
    expect(store.states[0]).toMatchObject({ state: "sent" });
    expect(store.intentStates[0]).toMatchObject({ state: "sent" });
  });

  it("não reivindica novamente uma mensagem expirada", async () => {
    const store = new MemoryAuthEmailIntentStore();
    const transport = new CaptureTransactionalEmailPort();
    await queueAuthEmail(store, {
      kind: "verification",
      userId: "user-expired",
      email: "expired@example.com",
      url: `${apiOrigin}/verify-expired`,
      token: "expired-token",
      callbackUrl: "/",
      correlationId: "01J6Q3B5M8G7T5N4R3Q2P1WXYZ",
      expiresAt: new Date(Date.now() - 1),
      sourceId: "expired-source",
    });
    expect(await processPendingAuthEmails(store, transport)).toBe(0);
    expect(await processPendingAuthEmails(store, transport)).toBe(0);
    expect(transport.messages).toHaveLength(0);
    expect(store.intentStates[0]).toMatchObject({ state: "expired" });
  });

  it("renova lease durante entrega lenta e evita claim concorrente", async () => {
    const store = new MemoryAuthEmailIntentStore();
    const transport = new CaptureTransactionalEmailPort();
    await queueAuthEmail(store, {
      kind: "verification",
      userId: "user-slow",
      email: "slow@example.com",
      url: `${apiOrigin}/verify-slow`,
      token: "slow-token",
      callbackUrl: "/",
      correlationId: "01J6Q3B5M8G7T5N4R3Q2P1WXYZ",
      expiresAt: new Date(Date.now() + 60_000),
      sourceId: "slow-source",
    });
    let firstSend = true;
    const slowTransport = {
      send: async (message: Parameters<TransactionalEmailPort["send"]>[0]) => {
        if (firstSend) {
          firstSend = false;
          await new Promise((resolve) => setTimeout(resolve, 140));
        }
        await transport.send(message);
      },
    };
    const first = processPendingAuthEmails(store, slowTransport, {
      leaseSeconds: 0.2,
      deliveryTimeoutMs: 1_000,
      backoffBaseMs: 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const second = processPendingAuthEmails(store, transport, {
      leaseSeconds: 0.2,
      backoffBaseMs: 0,
    });
    expect(await Promise.all([first, second])).toEqual([1, 0]);
    expect(transport.messages).toHaveLength(1);
  });

  it("aplica backoff e move falhas persistentes para dead-letter terminal", async () => {
    const store = new MemoryAuthEmailIntentStore();
    await queueAuthEmail(store, {
      kind: "verification",
      userId: "user-dead",
      email: "dead@example.com",
      url: `${apiOrigin}/verify-dead`,
      token: "dead-token",
      callbackUrl: "/",
      correlationId: "01J6Q3B5M8G7T5N4R3Q2P1WXYZ",
      expiresAt: new Date(Date.now() + 60_000),
      sourceId: "dead-source",
    });
    const failing = {
      send: async () => {
        throw new Error("SMTP down");
      },
    };
    expect(
      await processPendingAuthEmails(store, failing, { maxAttempts: 2, backoffBaseMs: 100 }),
    ).toBe(0);
    expect(
      await processPendingAuthEmails(store, failing, { maxAttempts: 2, backoffBaseMs: 0 }),
    ).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(
      await processPendingAuthEmails(store, failing, { maxAttempts: 2, backoffBaseMs: 0 }),
    ).toBe(0);
    expect(store.deadLetters).toEqual(["dead-source"]);
    expect(store.intentStates[0]).toMatchObject({ state: "failed" });
  });

  it("expõe falha de enqueue mesmo quando Better Auth retorna sucesso", async () => {
    const emailPort = new CaptureTransactionalEmailPort();
    const emailStore = new MemoryAuthEmailIntentStore();
    const failureSink = new CaptureAuthEmailEnqueueFailureSink();
    const originalEnqueue = emailStore.enqueue.bind(emailStore);
    let fail = true;
    emailStore.enqueue = async (message) => {
      if (fail) {
        fail = false;
        throw new Error("database unavailable");
      }
      return originalEnqueue(message);
    };
    const auth = createAuth({
      database: memoryAdapter(memoryDatabase()),
      emailPort,
      emailStore,
      emailFailureSink: failureSink,
      emailEnqueueMaxAttempts: 1,
      baseURL: apiOrigin,
      trustedOrigins: [apiOrigin, webOrigin],
      trustedProxies: ["127.0.0.1"],
      secret: authSecret,
    });
    const app = createApp(undefined, {
      authHandler: (request) => auth.handler(request),
      authOrigins: [apiOrigin, webOrigin],
    });
    const response = await authRequest(app, "sign-up/email", {
      ...jsonBody({
        name: "Ada Lovelace",
        email: "enqueue-failure@example.com",
        password: "correct-horse-battery",
      }),
      headers: { "X-Forwarded-For": "198.51.100.43" },
    });
    expect(response.status).toBe(200);
    expect(failureSink.failures).toHaveLength(1);
    expect(failureSink.failures[0]?.message.token).toBeTruthy();
    await recoverAuthEmailEnqueueFailure(
      emailStore,
      failureSink.failures[0] as AuthEmailEnqueueFailure,
    );
    await processPendingAuthEmails(emailStore, emailPort);
    expect(emailPort.messages).toHaveLength(1);
  });

  it("recupera falha de enqueue de um spool criptografado depois de reiniciar o processo", async () => {
    const directory = await mkdtemp(join(tmpdir(), "casei-auth-email-"));
    const spoolPath = join(directory, "recovery.ndjson");
    const message = {
      kind: "verification" as const,
      userId: "user-restart",
      email: "restart@example.com",
      url: `${apiOrigin}/verify-restart?token=secret-token`,
      token: "secret-token",
      callbackUrl: "/",
      correlationId: "01J6Q3B5M8G7T5N4R3Q2P1WXYZ",
      expiresAt: new Date(Date.now() + 60_000),
      sourceId: "restart-source",
    };
    const failedStore = new MemoryAuthEmailIntentStore();
    failedStore.enqueue = async () => {
      throw new Error("database unavailable");
    };
    const firstProcessSink = new FileAuthEmailEnqueueFailureSink(spoolPath, authSecret);

    await expect(
      queueAuthEmail(failedStore, message, firstProcessSink, { maxAttempts: 1 }),
    ).rejects.toThrow("database unavailable");
    expect(await readFile(spoolPath, "utf8")).not.toContain("secret-token");

    const afterRestartStore = new MemoryAuthEmailIntentStore();
    const afterRestartSink = new FileAuthEmailEnqueueFailureSink(spoolPath, authSecret);
    expect(await recoverDurableAuthEmailEnqueueFailures(afterRestartStore, afterRestartSink)).toBe(
      1,
    );
    expect(
      await processPendingAuthEmails(afterRestartStore, new CaptureTransactionalEmailPort()),
    ).toBe(1);
    await expect(readFile(spoolPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await rm(directory, { recursive: true, force: true });
  });

  it("não permite transição depois que o lease expirou", async () => {
    const store = new MemoryAuthEmailIntentStore();
    await queueAuthEmail(store, {
      kind: "verification",
      userId: "user-stale-lease",
      email: "stale@example.com",
      url: `${apiOrigin}/verify-stale`,
      token: "stale-token",
      callbackUrl: "/",
      correlationId: "01J6Q3B5M8G7T5N4R3Q2P1WXYZ",
      expiresAt: new Date(Date.now() + 60_000),
      sourceId: "stale-source",
    });
    const [claimed] = await store.claimPending(1, 0.01);
    if (!claimed) throw new Error("expected a claimed message");
    await new Promise((resolve) => setTimeout(resolve, 25));

    await store.markSent(claimed.id, claimed.leaseUntil);
    await store.markFailed(claimed.id, "late", claimed.leaseUntil);
    await store.markDeadLetter(claimed.id, "late", claimed.leaseUntil);
    expect(store.states[0]).toMatchObject({ state: "pending" });
  });

  it("renova todos os leases de um lote durante entregas lentas", async () => {
    const store = new MemoryAuthEmailIntentStore();
    for (const suffix of ["one", "two", "three"]) {
      await queueAuthEmail(store, {
        kind: "verification",
        userId: `user-batch-${suffix}`,
        email: `${suffix}@example.com`,
        url: `${apiOrigin}/verify-${suffix}`,
        token: `${suffix}-token`,
        callbackUrl: "/",
        correlationId: "01J6Q3B5M8G7T5N4R3Q2P1WXYZ",
        expiresAt: new Date(Date.now() + 60_000),
        sourceId: `batch-${suffix}`,
      });
    }
    const transport = new CaptureTransactionalEmailPort();
    const slowTransport = {
      send: async (message: Parameters<TransactionalEmailPort["send"]>[0]) => {
        await new Promise((resolve) => setTimeout(resolve, 140));
        await transport.send(message);
      },
    };

    expect(
      await processPendingAuthEmails(store, slowTransport, {
        leaseSeconds: 0.2,
        deliveryTimeoutMs: 1_000,
        backoffBaseMs: 0,
      }),
    ).toBe(3);
    expect(transport.messages).toHaveLength(3);
  });

  it("só usa headers de IP quando proxies confiáveis estão configurados", () => {
    expect(defaultAuthIpAddressOptions([])).toEqual({ ipAddressHeaders: [] });
    expect(defaultAuthIpAddressOptions(["10.20.30.40/32"])).toEqual({
      ipAddressHeaders: ["x-forwarded-for"],
      trustedProxies: ["10.20.30.40/32"],
    });
    const previous = process.env.CASEI_TRUSTED_PROXIES;
    try {
      process.env.CASEI_TRUSTED_PROXIES = "not-an-ip";
      expect(() => defaultTrustedProxies()).toThrow(/Invalid trusted proxy/);
    } finally {
      if (previous === undefined) delete process.env.CASEI_TRUSTED_PROXIES;
      else process.env.CASEI_TRUSTED_PROXIES = previous;
    }
  });

  it("revoga sessões existentes depois de redefinir a senha", async () => {
    const { app, emailPort, emailStore } = fixture();
    await authRequest(app, "sign-up/email", {
      ...jsonBody({
        name: "Ada Lovelace",
        email: "reset-session@example.com",
        password: "correct-horse-battery",
      }),
      headers: { "X-Forwarded-For": "198.51.100.42" },
    });
    await processPendingAuthEmails(emailStore, emailPort);
    const verificationMessage = emailPort.messages[0];
    if (!verificationMessage) throw new Error("expected verification message");
    await app.request(verificationMessage.url, { headers: { Origin: webOrigin } });

    const login = await authRequest(
      app,
      "sign-in/email",
      jsonBody({ email: "reset-session@example.com", password: "correct-horse-battery" }),
    );
    const cookie = sessionCookie(login);
    const resetRequest = await authRequest(
      app,
      "request-password-reset",
      jsonBody({ email: "reset-session@example.com", redirectTo: `${webOrigin}/reset` }),
    );
    expect(resetRequest.status).toBe(200);
    await processPendingAuthEmails(emailStore, emailPort);
    const resetMessage = emailPort.messages[1];
    if (!resetMessage) throw new Error("expected reset message");
    const resetLink = await app.request(resetMessage.url, { headers: { Origin: webOrigin } });
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
    const current = await authRequest(app, "get-session", { headers: { Cookie: cookie } });
    await expect(current.json()).resolves.toBeNull();
  });

  it("exige SMTP autenticado e TLS explícito em produção", () => {
    const names = [
      "SMTP_HOST",
      "SMTP_PORT",
      "SMTP_FROM",
      "SMTP_USER",
      "SMTP_PASSWORD",
      "SMTP_SECURE",
    ];
    const previous = new Map(names.map((name) => [name, process.env[name]]));
    try {
      process.env.SMTP_HOST = "smtp.example.com";
      process.env.SMTP_PORT = "465";
      process.env.SMTP_FROM = "Casei <no-reply@example.com>";
      process.env.SMTP_USER = "mailer";
      process.env.SMTP_PASSWORD = "secret";
      process.env.SMTP_SECURE = "true";
      expect(smtpConfigFromEnvironment()).toMatchObject({ secure: true, user: "mailer" });

      process.env.SMTP_SECURE = "false";
      expect(() => smtpConfigFromEnvironment()).toThrow(/SMTP_SECURE/);

      delete process.env.SMTP_PASSWORD;
      expect(() => smtpConfigFromEnvironment()).toThrow(/SMTP_PASSWORD/);
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("verifica transportes de produção no startup sem exigir verify no capture", async () => {
    let verified = false;
    await verifyTransactionalEmailPort({
      send: async () => undefined,
      verify: async () => {
        verified = true;
      },
    });
    expect(verified).toBe(true);
    await expect(
      verifyTransactionalEmailPort(new CaptureTransactionalEmailPort()),
    ).resolves.toBeUndefined();
  });
});
