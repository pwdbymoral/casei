import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { authEmailIntent, authEmailOutbox, type createDatabase } from "@casei/database";
import { and, eq, gt, lte, or, sql } from "drizzle-orm";
import nodemailer from "nodemailer";

type Database = ReturnType<typeof createDatabase>;
type AuthEmailOutboxUpdate = Partial<typeof authEmailOutbox.$inferInsert>;

export type AuthEmailKind = "verification" | "password_reset" | "invitation";

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

/** Shared by identity commands so invitation payloads use the same encrypted
 * auth_email_outbox contract as Better Auth messages. */
export function encryptAuthEmailPayload(message: AuthEmailMessage, secret: string): string {
  return encryptPayload(message, secret);
}

export function hashAuthEmailAddress(email: string, secret: string): string {
  return emailHash(email, secret);
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

export interface AuthEmailEnqueueFailure {
  message: AuthEmailMessage;
  occurredAt: Date;
}

export interface AuthEmailEnqueueFailureSink {
  record(failure: AuthEmailEnqueueFailure): Promise<void>;
}

export interface AuthEmailEnqueueFailureRecoverySource {
  recover(store: AuthEmailIntentStore): Promise<number>;
}

/** Test/local sink that exposes failures without logging token-bearing data. */
export class CaptureAuthEmailEnqueueFailureSink implements AuthEmailEnqueueFailureSink {
  readonly failures: AuthEmailEnqueueFailure[] = [];

  async record(failure: AuthEmailEnqueueFailure): Promise<void> {
    this.failures.push(failure);
  }
}

/** Production sink: emit only non-sensitive routing metadata for alerting. */
export class LoggingAuthEmailEnqueueFailureSink implements AuthEmailEnqueueFailureSink {
  async record(failure: AuthEmailEnqueueFailure): Promise<void> {
    console.error("auth email enqueue failed", {
      kind: failure.message.kind,
      sourceId: failure.message.sourceId,
      correlationId: failure.message.correlationId,
      occurredAt: failure.occurredAt.toISOString(),
    });
  }
}

/**
 * Encrypted append-only recovery spool for the small window in which Better
 * Auth has committed a user but the primary database cannot persist the
 * email intent. The worker drains it before claiming the regular outbox.
 * Deployments must place this file on persistent, process-private storage.
 */
export class FileAuthEmailEnqueueFailureSink
  implements AuthEmailEnqueueFailureSink, AuthEmailEnqueueFailureRecoverySource
{
  private operation = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly encryptionSecret: string,
  ) {}

  async record(failure: AuthEmailEnqueueFailure): Promise<void> {
    await this.serialized(async () => {
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
      const line = `${JSON.stringify({
        occurredAt: failure.occurredAt.toISOString(),
        payload: encryptPayload(failure.message, this.encryptionSecret),
      })}\n`;
      await appendFile(this.filePath, line, { encoding: "utf8", mode: 0o600 });
    });
  }

  async recover(store: AuthEmailIntentStore): Promise<number> {
    return this.serialized(async () => {
      let content: string;
      try {
        content = await readFile(this.filePath, "utf8");
      } catch (error) {
        if (isFileNotFound(error)) return 0;
        throw error;
      }

      const remaining: string[] = [];
      let recovered = 0;
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line) as { payload?: unknown };
          if (typeof record.payload !== "string") throw new Error("invalid recovery record");
          const message = decryptPayload(record.payload, this.encryptionSecret);
          await store.enqueue(message);
          recovered += 1;
        } catch {
          // A transient store failure, a partial write, or a future schema
          // version stays durable for a later supervised retry.
          remaining.push(line);
        }
      }

      if (remaining.length === 0) {
        await unlink(this.filePath).catch((error: unknown) => {
          if (!isFileNotFound(error)) throw error;
        });
      } else if (recovered > 0) {
        const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
        await writeFile(temporaryPath, `${remaining.join("\n")}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        await rename(temporaryPath, this.filePath);
      }
      return recovered;
    });
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operation;
    let release!: () => void;
    this.operation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function isFileNotFound(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export interface ClaimedAuthEmail {
  id: string;
  state: "pending" | "failed";
  attempts: number;
  leaseUntil: Date;
  message: AuthEmailMessage;
}

export interface AuthEmailIntentStore {
  enqueue(message: AuthEmailMessage): Promise<QueuedAuthEmail>;
  claimPending(limit?: number, leaseSeconds?: number): Promise<ClaimedAuthEmail[]>;
  renewLease(id: string, leaseUntil: Date, leaseSeconds: number): Promise<Date | null>;
  markSent(id: string, leaseUntil: Date): Promise<void>;
  markFailed(id: string, reason: string, leaseUntil: Date, retryAt?: Date): Promise<void>;
  markExpired(id: string, leaseUntil: Date): Promise<void>;
  markDeadLetter(id: string, reason: string, leaseUntil: Date): Promise<void>;
  pending(): Promise<AuthEmailMessage[]>;
}

export interface AuthEmailWorkerOptions {
  limit?: number;
  leaseSeconds?: number;
  deliveryTimeoutMs?: number;
  maxAttempts?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

const NEVER_AVAILABLE = new Date("9999-12-31T00:00:00.000Z");

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
    const invitation = message.kind === "invitation";
    await this.transporter.sendMail({
      from: this.config.from,
      to: message.email,
      subject: reset
        ? "Redefina sua senha do Casei"
        : invitation
          ? "Você foi convidado para um espaço no Casei"
          : "Confirme seu e-mail do Casei",
      text: reset
        ? `Redefina sua senha acessando: ${message.url}`
        : invitation
          ? `Você foi convidado para um espaço no Casei. Aceite o convite acessando: ${message.url}`
          : `Confirme seu e-mail acessando: ${message.url}`,
      html: reset
        ? `<p>Redefina sua senha do Casei:</p><p><a href="${escapeHtml(message.url)}">Continuar</a></p>`
        : invitation
          ? `<p>Você foi convidado para um espaço no Casei.</p><p><a href="${escapeHtml(message.url)}">Aceitar convite</a></p>`
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
  intentState: "queued" | "sent" | "failed" | "expired";
  deadLetter: boolean;
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
      intentState: "queued",
      deadLetter: false,
    };
    this.items.set(`${message.kind}:${message.sourceId}`, item);
    return { id: item.id, state: item.state };
  }

  async markSent(id: string, leaseUntil: Date): Promise<void> {
    const item = this.findById(id);
    if (
      item &&
      item.availableAt.getTime() === leaseUntil.getTime() &&
      item.availableAt.getTime() > Date.now()
    ) {
      item.state = "sent";
      item.intentState = "sent";
    }
  }

  async markFailed(
    id: string,
    _reason: string,
    leaseUntil: Date,
    retryAt = new Date(),
  ): Promise<void> {
    const item = this.findById(id);
    if (
      item &&
      item.availableAt.getTime() === leaseUntil.getTime() &&
      item.availableAt.getTime() > Date.now()
    ) {
      item.state = "failed";
      item.intentState = "failed";
      item.availableAt = retryAt;
    }
  }

  async markExpired(id: string, leaseUntil: Date): Promise<void> {
    const item = this.findById(id);
    if (
      item &&
      item.availableAt.getTime() === leaseUntil.getTime() &&
      item.availableAt.getTime() > Date.now()
    ) {
      item.state = "failed";
      item.intentState = "expired";
      item.availableAt = NEVER_AVAILABLE;
    }
  }

  async markDeadLetter(id: string, _reason: string, leaseUntil: Date): Promise<void> {
    const item = this.findById(id);
    if (
      item &&
      item.availableAt.getTime() === leaseUntil.getTime() &&
      item.availableAt.getTime() > Date.now()
    ) {
      item.state = "failed";
      item.intentState = "failed";
      item.deadLetter = true;
      item.availableAt = NEVER_AVAILABLE;
    }
  }

  async claimPending(limit = 100, leaseSeconds = 60): Promise<ClaimedAuthEmail[]> {
    const now = Date.now();
    const leaseUntil = new Date(now + leaseSeconds * 1000);
    const claimed: ClaimedAuthEmail[] = [];
    for (const item of this.items.values()) {
      if (claimed.length >= limit) break;
      if (
        item.deadLetter ||
        (item.state !== "pending" && item.state !== "failed") ||
        item.availableAt.getTime() > now
      ) {
        continue;
      }
      item.availableAt = leaseUntil;
      item.attempts += 1;
      claimed.push({
        id: item.id,
        state: item.state,
        attempts: item.attempts,
        leaseUntil,
        message: item.message,
      });
    }
    return claimed;
  }

  async renewLease(id: string, leaseUntil: Date, leaseSeconds: number): Promise<Date | null> {
    const item = this.findById(id);
    if (
      !item ||
      item.availableAt.getTime() !== leaseUntil.getTime() ||
      item.availableAt.getTime() <= Date.now()
    ) {
      return null;
    }
    const renewed = new Date(Date.now() + leaseSeconds * 1000);
    item.availableAt = renewed;
    return renewed;
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

  get intentStates(): ReadonlyArray<{ sourceId: string; state: StoredMessage["intentState"] }> {
    return [...this.items.values()].map((item) => ({
      sourceId: item.message.sourceId,
      state: item.intentState,
    }));
  }

  get deadLetters(): ReadonlyArray<string> {
    return [...this.items.values()]
      .filter((item) => item.deadLetter)
      .map((item) => item.message.sourceId);
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
          state: "queued",
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

  private async transition(
    id: string,
    leaseUntil: Date,
    outboxValues: AuthEmailOutboxUpdate,
    intentState: "queued" | "sent" | "failed" | "expired",
  ): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const where = and(
        eq(authEmailOutbox.id, id),
        eq(authEmailOutbox.availableAt, leaseUntil),
        gt(authEmailOutbox.availableAt, new Date()),
      );
      const [row] = await transaction
        .select({ intentId: authEmailOutbox.intentId })
        .from(authEmailOutbox)
        .where(where)
        .limit(1)
        .for("update");
      if (!row) return;
      await transaction.update(authEmailOutbox).set(outboxValues).where(where);
      await transaction
        .update(authEmailIntent)
        .set({ state: intentState, updatedAt: new Date() })
        .where(eq(authEmailIntent.id, row.intentId));
    });
  }

  async markSent(id: string, leaseUntil: Date): Promise<void> {
    await this.transition(
      id,
      leaseUntil,
      { state: "sent", sentAt: new Date(), lastError: null },
      "sent",
    );
  }

  async markFailed(
    id: string,
    reason: string,
    leaseUntil: Date,
    retryAt = new Date(),
  ): Promise<void> {
    await this.transition(
      id,
      leaseUntil,
      { state: "failed", availableAt: retryAt, lastError: reason.slice(0, 500) },
      "failed",
    );
  }

  async markExpired(id: string, leaseUntil: Date): Promise<void> {
    await this.transition(
      id,
      leaseUntil,
      { state: "failed", availableAt: NEVER_AVAILABLE, lastError: "auth email expired" },
      "expired",
    );
  }

  async markDeadLetter(id: string, reason: string, leaseUntil: Date): Promise<void> {
    await this.transition(
      id,
      leaseUntil,
      {
        state: "failed",
        availableAt: NEVER_AVAILABLE,
        lastError: `dead-letter: ${reason}`.slice(0, 500),
      },
      "failed",
    );
  }

  async claimPending(limit = 100, leaseSeconds = 60): Promise<ClaimedAuthEmail[]> {
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + leaseSeconds * 1000);
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select({
          id: authEmailOutbox.id,
          intentId: authEmailOutbox.intentId,
          state: authEmailOutbox.state,
          attempts: authEmailOutbox.attempts,
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
        await transaction
          .update(authEmailIntent)
          .set({
            state: "queued",
            attempts: sql<number>`${authEmailIntent.attempts} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(authEmailIntent.id, row.intentId));
        claimed.push({
          id: row.id,
          state: row.state === "failed" ? "failed" : "pending",
          attempts: row.attempts + 1,
          leaseUntil,
          message: decryptPayload(row.payload, this.encryptionSecret),
        });
      }
      return claimed;
    });
  }

  async renewLease(id: string, leaseUntil: Date, leaseSeconds: number): Promise<Date | null> {
    const now = new Date();
    const renewed = new Date(now.getTime() + leaseSeconds * 1000);
    const [row] = await this.database
      .update(authEmailOutbox)
      .set({ availableAt: renewed })
      .where(
        and(
          eq(authEmailOutbox.id, id),
          eq(authEmailOutbox.availableAt, leaseUntil),
          gt(authEmailOutbox.availableAt, now),
        ),
      )
      .returning({ availableAt: authEmailOutbox.availableAt });
    return row?.availableAt ?? null;
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
  failureSink?: AuthEmailEnqueueFailureSink,
  options: { maxAttempts?: number; retryBaseMs?: number } = {},
): Promise<QueuedAuthEmail> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const retryBaseMs = Math.max(0, options.retryBaseMs ?? 25);
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await store.enqueue(message);
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts && retryBaseMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, retryBaseMs * 2 ** (attempt - 1)));
      }
    }
  }
  if (failureSink) {
    await failureSink.record({ message, occurredAt: new Date() });
  }
  throw lastError instanceof Error ? lastError : new Error("Could not persist auth email");
}

/** Replay a captured enqueue failure after the persistence dependency recovers. */
export async function recoverAuthEmailEnqueueFailure(
  store: AuthEmailIntentStore,
  failure: AuthEmailEnqueueFailure,
): Promise<QueuedAuthEmail> {
  return queueAuthEmail(store, failure.message);
}

/** Drain the encrypted process-restart spool before regular outbox claims. */
export async function recoverDurableAuthEmailEnqueueFailures(
  store: AuthEmailIntentStore,
  source: AuthEmailEnqueueFailureRecoverySource,
): Promise<number> {
  return source.recover(store);
}

/** @deprecated Use queueAuthEmail; delivery is owned by processPendingAuthEmails. */
export const dispatchQueuedAuthEmail = queueAuthEmail;

/** Process one durable worker batch. The API only enqueues; this function owns delivery. */
export async function processPendingAuthEmails(
  store: AuthEmailIntentStore,
  transport: TransactionalEmailPort,
  options: AuthEmailWorkerOptions | number = {},
): Promise<number> {
  const workerOptions = typeof options === "number" ? { limit: options } : options;
  const limit = workerOptions.limit ?? 100;
  const leaseSeconds = workerOptions.leaseSeconds ?? 60;
  const deliveryTimeoutMs = workerOptions.deliveryTimeoutMs ?? 120_000;
  const maxAttempts = workerOptions.maxAttempts ?? 5;
  const backoffBaseMs = workerOptions.backoffBaseMs ?? 1_000;
  const backoffMaxMs = workerOptions.backoffMaxMs ?? 60 * 60 * 1000;
  const claimedItems = await store.claimPending(limit, leaseSeconds);

  // Each claimed row has its own lease-renewal loop. Processing the whole
  // batch concurrently prevents the first rows from expiring while later
  // rows are waiting behind a slow SMTP provider.
  const results = await Promise.all(
    claimedItems.map(async (claimed) => {
      if (claimed.message.expiresAt.getTime() <= Date.now()) {
        await store.markExpired(claimed.id, claimed.leaseUntil);
        return 0;
      }
      if (claimed.attempts > maxAttempts) {
        await store.markDeadLetter(
          claimed.id,
          "maximum delivery attempts exceeded",
          claimed.leaseUntil,
        );
        return 0;
      }

      let currentLease = claimed.leaseUntil;
      let renewalInFlight: Promise<void> | undefined;
      const renewalInterval = setInterval(
        () => {
          if (renewalInFlight) return;
          renewalInFlight = store
            .renewLease(claimed.id, currentLease, leaseSeconds)
            .then((renewed) => {
              if (renewed) currentLease = renewed;
            })
            .catch(() => undefined)
            .finally(() => {
              renewalInFlight = undefined;
            });
        },
        Math.max(50, (leaseSeconds * 1000) / 3),
      );

      try {
        await withTimeout(transport.send(claimed.message), deliveryTimeoutMs);
        if (renewalInFlight) await renewalInFlight;
        await store.markSent(claimed.id, currentLease);
        return 1;
      } catch {
        // Provider errors can contain recipients, URLs or provider response
        // bodies. Keep the durable error safe for operators and retries.
        if (claimed.attempts >= maxAttempts) {
          await store.markDeadLetter(
            claimed.id,
            "maximum delivery attempts exceeded",
            currentLease,
          );
        } else {
          const backoff = Math.min(
            backoffMaxMs,
            backoffBaseMs * 2 ** Math.max(0, claimed.attempts - 1),
          );
          const jitter = backoff > 0 ? Math.floor(Math.random() * Math.max(1, backoff * 0.1)) : 0;
          await store.markFailed(
            claimed.id,
            "email delivery failed",
            currentLease,
            new Date(Date.now() + backoff + jitter),
          );
        }
        return 0;
      } finally {
        clearInterval(renewalInterval);
      }
    }),
  );
  return results.reduce<number>((total, value) => total + value, 0);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("email delivery timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export const recoverPendingAuthEmails = processPendingAuthEmails;
