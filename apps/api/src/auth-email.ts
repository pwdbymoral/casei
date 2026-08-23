import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { authEmailIntent, authEmailOutbox, type createDatabase } from "@casei/database";
import { and, eq, lte, or, sql } from "drizzle-orm";
import nodemailer from "nodemailer";

type Database = ReturnType<typeof createDatabase>;

export type AuthEmailKind = "verification" | "password_reset";

export interface AuthEmailMessage {
  kind: AuthEmailKind;
  userId: string;
  email: string;
  url: string;
  token: string;
  callbackUrl: string | null;
  correlationId: string;
  expiresAt: Date;
  sourceId: string;
}

export interface TransactionalEmailPort {
  send(message: AuthEmailMessage): Promise<void>;
}

export interface VerifiableTransactionalEmailPort extends TransactionalEmailPort {
  verify?: () => Promise<void>;
}

export interface QueuedAuthEmail {
  id: string;
  state: "pending" | "sent" | "failed";
}

export interface ClaimedAuthEmail {
  id: string;
  state: "pending" | "failed";
  leaseUntil: Date;
  message: AuthEmailMessage;
}

export interface AuthEmailIntentStore {
  enqueue(message: AuthEmailMessage): Promise<QueuedAuthEmail>;
  claimPending(limit?: number, leaseSeconds?: number): Promise<ClaimedAuthEmail[]>;
  markSent(id: string, leaseUntil?: Date): Promise<void>;
  markFailed(id: string, reason: string, leaseUntil?: Date): Promise<void>;
  markExpired(id: string, leaseUntil?: Date): Promise<void>;
  pending(): Promise<AuthEmailMessage[]>;
}

/** Capture adapter for tests and local development. It never talks to SMTP. */
export class CaptureTransactionalEmailPort implements TransactionalEmailPort {
  readonly messages: AuthEmailMessage[] = [];

  async send(message: AuthEmailMessage): Promise<void> {
    this.messages.push(message);
  }
}

/** Explicit failure for a published deployment without a configured transport. */
export class UnconfiguredTransactionalEmailPort implements TransactionalEmailPort {
  async send(_message: AuthEmailMessage): Promise<void> {
    throw new Error("Transactional email transport is not configured");
  }
}

export interface SmtpEmailConfig {
  host: string;
  port: number;
  secure: true;
  from: string;
  user: string;
  password: string;
}

export class NodemailerTransactionalEmailPort implements TransactionalEmailPort {
  private readonly transporter;

  constructor(private readonly config: SmtpEmailConfig) {
    this.transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      requireTLS: true,
      tls: { rejectUnauthorized: true },
      auth: { user: config.user, pass: config.password },
    });
  }

  async send(message: AuthEmailMessage): Promise<void> {
    const reset = message.kind === "password_reset";
    await this.transporter.sendMail({
      from: this.config.from,
      to: message.email,
      subject: reset ? "Redefina sua senha do Casei" : "Confirme seu e-mail do Casei",
      text: reset
        ? `Redefina sua senha acessando: ${message.url}`
        : `Confirme seu e-mail acessando: ${message.url}`,
      html: reset
        ? `<p>Redefina sua senha do Casei:</p><p><a href="${escapeHtml(message.url)}">Continuar</a></p>`
        : `<p>Confirme seu e-mail do Casei:</p><p><a href="${escapeHtml(message.url)}">Confirmar e-mail</a></p>`,
    });
  }

  async verify(): Promise<void> {
    await this.transporter.verify();
  }
}

/** Validate a configured provider at worker startup without affecting capture tests. */
export async function verifyTransactionalEmailPort(
  port: VerifiableTransactionalEmailPort,
): Promise<void> {
  if (port.verify) await port.verify();
}

export function smtpConfigFromEnvironment(): SmtpEmailConfig {
  const host = process.env.SMTP_HOST;
  const from = process.env.SMTP_FROM;
  const user = process.env.SMTP_USER;
  const password = process.env.SMTP_PASSWORD;
  if (!host || !from || !user || !password) {
    throw new Error("SMTP_HOST, SMTP_FROM, SMTP_USER and SMTP_PASSWORD are required in production");
  }
  const port = Number.parseInt(process.env.SMTP_PORT ?? "465", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("SMTP_PORT must be a valid port");
  }
  if (process.env.SMTP_SECURE !== undefined && process.env.SMTP_SECURE !== "true") {
    throw new Error("SMTP_SECURE must be true in production");
  }
  const fromAddress = from.match(/<([^>]+)>/)?.[1] ?? from;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromAddress)) {
    throw new Error("SMTP_FROM must be a valid email address");
  }
  return {
    host,
    port,
    secure: true,
    from,
    user,
    password,
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;",
    };
    return entities[character] ?? character;
  });
}

type StoredMessage = QueuedAuthEmail & {
  message: AuthEmailMessage;
  availableAt: Date;
  attempts: number;
};

export class MemoryAuthEmailIntentStore implements AuthEmailIntentStore {
  private readonly items = new Map<string, StoredMessage>();

  async enqueue(message: AuthEmailMessage): Promise<QueuedAuthEmail> {
    const existing = this.items.get(`${message.kind}:${message.sourceId}`);
    if (existing) return { id: existing.id, state: existing.state };

    const item: StoredMessage = {
      id: randomUUID(),
      state: "pending",
      message,
      availableAt: new Date(),
      attempts: 0,
    };
    this.items.set(`${message.kind}:${message.sourceId}`, item);
    return { id: item.id, state: item.state };
  }

  async markSent(id: string, leaseUntil?: Date): Promise<void> {
    const item = this.findById(id);
    if (item && (!leaseUntil || item.availableAt.getTime() === leaseUntil.getTime())) {
      item.state = "sent";
    }
  }

  async markFailed(id: string, _reason: string, leaseUntil?: Date): Promise<void> {
    const item = this.findById(id);
    if (item && (!leaseUntil || item.availableAt.getTime() === leaseUntil.getTime())) {
      item.state = "failed";
      item.availableAt = new Date();
    }
  }

  async markExpired(id: string, leaseUntil?: Date): Promise<void> {
    const item = this.findById(id);
    if (item && (!leaseUntil || item.availableAt.getTime() === leaseUntil.getTime())) {
      item.state = "failed";
      item.availableAt = new Date("9999-12-31T00:00:00.000Z");
    }
  }

  async claimPending(limit = 100, leaseSeconds = 60): Promise<ClaimedAuthEmail[]> {
    const now = Date.now();
    const leaseUntil = new Date(now + leaseSeconds * 1000);
    const claimed: ClaimedAuthEmail[] = [];
    for (const item of this.items.values()) {
      if (claimed.length >= limit) break;
      if (
        (item.state !== "pending" && item.state !== "failed") ||
        item.availableAt.getTime() > now
      ) {
        continue;
      }
      item.availableAt = leaseUntil;
      item.attempts += 1;
      claimed.push({ id: item.id, state: item.state, leaseUntil, message: item.message });
    }
    return claimed;
  }

  async pending(): Promise<AuthEmailMessage[]> {
    return [...this.items.values()]
      .filter((item) => item.state === "pending" || item.state === "failed")
      .map((item) => item.message);
  }

  get states(): ReadonlyArray<QueuedAuthEmail & { sourceId: string }> {
    return [...this.items.values()].map((item) => ({
      id: item.id,
      state: item.state,
      sourceId: item.message.sourceId,
    }));
  }

  private findById(id: string): StoredMessage | undefined {
    return [...this.items.values()].find((item) => item.id === id);
  }
}

const keyFromSecret = (secret: string) => createHash("sha256").update(secret).digest();

function encryptPayload(message: AuthEmailMessage, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFromSecret(secret), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(message), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString("base64url")).join(".");
}

function decryptPayload(payload: string, secret: string): AuthEmailMessage {
  const [ivValue, tagValue, encryptedValue] = payload.split(".");
  if (!ivValue || !tagValue || !encryptedValue) throw new Error("Invalid auth email payload");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    keyFromSecret(secret),
    Buffer.from(ivValue, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, "base64url")),
    decipher.final(),
  ]).toString("utf8");
  const value = JSON.parse(plaintext) as AuthEmailMessage;
  return { ...value, expiresAt: new Date(value.expiresAt) };
}

function emailHash(email: string, secret: string): string {
  return createHash("sha256").update(`${secret}\0${email.trim().toLowerCase()}`).digest("hex");
}

/**
 * PostgreSQL-backed intent/outbox adapter. Tokens and URLs are encrypted at
 * rest; only their hash is used for the idempotency key.
 */
export class DrizzleAuthEmailIntentStore implements AuthEmailIntentStore {
  constructor(
    private readonly database: Database,
    private readonly encryptionSecret: string,
  ) {}

  async enqueue(message: AuthEmailMessage): Promise<QueuedAuthEmail> {
    const created = await this.database.transaction(async (transaction) => {
      // The unique index is the final guard, but the advisory lock makes the
      // read/insert decision atomic and prevents a concurrent request from
      // creating an orphaned intent before the unique-index conflict.
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${message.sourceId}, 0))`,
      );
      const existing = await transaction
        .select({ id: authEmailOutbox.id, state: authEmailOutbox.state })
        .from(authEmailOutbox)
        .where(
          and(
            eq(authEmailOutbox.messageKind, message.kind),
            eq(authEmailOutbox.sourceId, message.sourceId),
          ),
        )
        .limit(1);
      if (existing[0]) {
        return {
          id: existing[0].id,
          state: normalizeState(existing[0].state),
        };
      }
      const [intent] = await transaction
        .insert(authEmailIntent)
        .values({
          kind: message.kind,
          actorId: message.userId,
          emailHash: emailHash(message.email, this.encryptionSecret),
          callbackUrl: message.callbackUrl ?? "",
          correlationId: message.correlationId,
          expiresAt: message.expiresAt,
        })
        .returning({ id: authEmailIntent.id });
      if (!intent) throw new Error("Could not persist auth email intent");

      const [outbox] = await transaction
        .insert(authEmailOutbox)
        .values({
          intentId: intent.id,
          messageKind: message.kind,
          sourceId: message.sourceId,
          encryptedPayload: encryptPayload(message, this.encryptionSecret),
        })
        .returning({ id: authEmailOutbox.id });
      if (!outbox) throw new Error("Could not persist auth email outbox");
      return { id: outbox.id, state: "pending" as const };
    });
    return created;
  }

  async markSent(id: string, leaseUntil?: Date): Promise<void> {
    const where = leaseUntil
      ? and(eq(authEmailOutbox.id, id), eq(authEmailOutbox.availableAt, leaseUntil))
      : eq(authEmailOutbox.id, id);
    await this.database
      .update(authEmailOutbox)
      .set({ state: "sent", sentAt: new Date(), lastError: null })
      .where(where);
  }

  async markFailed(id: string, reason: string, leaseUntil?: Date): Promise<void> {
    const where = leaseUntil
      ? and(eq(authEmailOutbox.id, id), eq(authEmailOutbox.availableAt, leaseUntil))
      : eq(authEmailOutbox.id, id);
    await this.database
      .update(authEmailOutbox)
      .set({ state: "failed", availableAt: new Date(), lastError: reason.slice(0, 500) })
      .where(where);
  }

  async markExpired(id: string, leaseUntil?: Date): Promise<void> {
    const where = leaseUntil
      ? and(eq(authEmailOutbox.id, id), eq(authEmailOutbox.availableAt, leaseUntil))
      : eq(authEmailOutbox.id, id);
    await this.database
      .update(authEmailOutbox)
      .set({
        state: "failed",
        availableAt: new Date("9999-12-31T00:00:00.000Z"),
        lastError: "auth email expired",
      })
      .where(where);
  }

  async claimPending(limit = 100, leaseSeconds = 60): Promise<ClaimedAuthEmail[]> {
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + leaseSeconds * 1000);
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select({
          id: authEmailOutbox.id,
          state: authEmailOutbox.state,
          payload: authEmailOutbox.encryptedPayload,
        })
        .from(authEmailOutbox)
        .where(
          and(
            or(eq(authEmailOutbox.state, "pending"), eq(authEmailOutbox.state, "failed")),
            lte(authEmailOutbox.availableAt, now),
          ),
        )
        .orderBy(authEmailOutbox.availableAt, authEmailOutbox.id)
        .limit(limit)
        .for("update", { skipLocked: true });

      const claimed: ClaimedAuthEmail[] = [];
      for (const row of rows) {
        await transaction
          .update(authEmailOutbox)
          .set({
            availableAt: leaseUntil,
            attempts: sql<number>`${authEmailOutbox.attempts} + 1`,
          })
          .where(eq(authEmailOutbox.id, row.id));
        claimed.push({
          id: row.id,
          state: row.state === "failed" ? "failed" : "pending",
          leaseUntil,
          message: decryptPayload(row.payload, this.encryptionSecret),
        });
      }
      return claimed;
    });
  }

  async pending(): Promise<AuthEmailMessage[]> {
    const rows = await this.database
      .select({ payload: authEmailOutbox.encryptedPayload })
      .from(authEmailOutbox)
      .where(or(eq(authEmailOutbox.state, "pending"), eq(authEmailOutbox.state, "failed")));
    return rows.map((row) => decryptPayload(row.payload, this.encryptionSecret));
  }
}

function normalizeState(state: string): QueuedAuthEmail["state"] {
  if (state === "sent" || state === "failed") return state;
  return "pending";
}

export async function queueAuthEmail(
  store: AuthEmailIntentStore,
  message: AuthEmailMessage,
): Promise<QueuedAuthEmail> {
  return store.enqueue(message);
}

/** @deprecated Use queueAuthEmail; delivery is owned by processPendingAuthEmails. */
export const dispatchQueuedAuthEmail = queueAuthEmail;

/** Process one durable worker batch. The API only enqueues; this function owns delivery. */
export async function processPendingAuthEmails(
  store: AuthEmailIntentStore,
  transport: TransactionalEmailPort,
  limit = 100,
): Promise<number> {
  let delivered = 0;
  for (const claimed of await store.claimPending(limit)) {
    if (claimed.message.expiresAt.getTime() <= Date.now()) {
      await store.markExpired(claimed.id, claimed.leaseUntil);
      continue;
    }
    try {
      await transport.send(claimed.message);
      await store.markSent(claimed.id, claimed.leaseUntil);
      delivered += 1;
    } catch {
      // Provider errors can contain recipients, URLs or provider response
      // bodies. Keep the durable error safe for operators and retries.
      await store.markFailed(claimed.id, "email delivery failed", claimed.leaseUntil);
    }
  }
  return delivered;
}

export const recoverPendingAuthEmails = processPendingAuthEmails;
