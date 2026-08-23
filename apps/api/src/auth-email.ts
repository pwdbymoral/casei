import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { authEmailIntent, authEmailOutbox, type createDatabase } from "@casei/database";
import { and, eq } from "drizzle-orm";
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

export interface QueuedAuthEmail {
  id: string;
  state: "pending" | "sent" | "failed";
}

export interface AuthEmailIntentStore {
  enqueue(message: AuthEmailMessage): Promise<QueuedAuthEmail>;
  markSent(id: string): Promise<void>;
  markFailed(id: string, reason: string): Promise<void>;
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
  secure: boolean;
  from: string;
  user?: string;
  password?: string;
}

export class NodemailerTransactionalEmailPort implements TransactionalEmailPort {
  private readonly transporter;

  constructor(private readonly config: SmtpEmailConfig) {
    this.transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth:
        config.user && config.password ? { user: config.user, pass: config.password } : undefined,
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
}

export function smtpConfigFromEnvironment(): SmtpEmailConfig {
  const host = process.env.SMTP_HOST;
  const from = process.env.SMTP_FROM;
  if (!host || !from) throw new Error("SMTP_HOST and SMTP_FROM are required in production");
  const port = Number.parseInt(process.env.SMTP_PORT ?? "465", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("SMTP_PORT must be a valid port");
  }
  return {
    host,
    port,
    secure: process.env.SMTP_SECURE !== "false",
    from,
    user: process.env.SMTP_USER,
    password: process.env.SMTP_PASSWORD,
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

type StoredMessage = QueuedAuthEmail & { message: AuthEmailMessage };

export class MemoryAuthEmailIntentStore implements AuthEmailIntentStore {
  private readonly items = new Map<string, StoredMessage>();

  async enqueue(message: AuthEmailMessage): Promise<QueuedAuthEmail> {
    const existing = this.items.get(`${message.kind}:${message.sourceId}`);
    if (existing) return { id: existing.id, state: existing.state };

    const item: StoredMessage = {
      id: randomUUID(),
      state: "pending",
      message,
    };
    this.items.set(`${message.kind}:${message.sourceId}`, item);
    return { id: item.id, state: item.state };
  }

  async markSent(id: string): Promise<void> {
    const item = this.findById(id);
    if (item) item.state = "sent";
  }

  async markFailed(id: string, _reason: string): Promise<void> {
    const item = this.findById(id);
    if (item) item.state = "failed";
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
    const existing = await this.database
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
      const state = normalizeState(existing[0].state);
      return { id: existing[0].id, state };
    }

    const created = await this.database.transaction(async (transaction) => {
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
      return outbox.id;
    });
    return { id: created, state: "pending" };
  }

  async markSent(id: string): Promise<void> {
    await this.database
      .update(authEmailOutbox)
      .set({ state: "sent", sentAt: new Date(), lastError: null })
      .where(eq(authEmailOutbox.id, id));
  }

  async markFailed(id: string, reason: string): Promise<void> {
    await this.database
      .update(authEmailOutbox)
      .set({ state: "failed", lastError: reason.slice(0, 500) })
      .where(eq(authEmailOutbox.id, id));
  }

  async pending(): Promise<AuthEmailMessage[]> {
    const rows = await this.database
      .select({ payload: authEmailOutbox.encryptedPayload })
      .from(authEmailOutbox)
      .where(eq(authEmailOutbox.state, "pending"));
    return rows.map((row) => decryptPayload(row.payload, this.encryptionSecret));
  }
}

function normalizeState(state: string): QueuedAuthEmail["state"] {
  if (state === "sent" || state === "failed") return state;
  return "pending";
}

export async function dispatchQueuedAuthEmail(
  store: AuthEmailIntentStore,
  transport: TransactionalEmailPort,
  message: AuthEmailMessage,
): Promise<QueuedAuthEmail> {
  const queued = await store.enqueue(message);
  if (queued.state === "sent") return queued;

  try {
    await transport.send(message);
    await store.markSent(queued.id);
    return { ...queued, state: "sent" };
  } catch (error) {
    await store.markFailed(
      queued.id,
      error instanceof Error ? error.message : "email delivery failed",
    );
    throw error;
  }
}

export async function recoverPendingAuthEmails(
  store: AuthEmailIntentStore,
  transport: TransactionalEmailPort,
): Promise<number> {
  let delivered = 0;
  for (const message of await store.pending()) {
    if (message.expiresAt.getTime() <= Date.now()) continue;
    await dispatchQueuedAuthEmail(store, transport, message);
    delivered += 1;
  }
  return delivered;
}
