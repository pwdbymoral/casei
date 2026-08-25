import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { createDatabase } from "@casei/database";
import { APIError, type BetterAuthOptions } from "better-auth";
import { betterAuth } from "better-auth/minimal";
import { twoFactor } from "better-auth/plugins";
import { sql } from "drizzle-orm";
import {
  type AuthEmailEnqueueFailureSink,
  type AuthEmailIntentStore,
  type AuthEmailKind,
  type AuthEmailMessage,
  DrizzleAuthEmailIntentStore,
  FileAuthEmailEnqueueFailureSink,
  LoggingAuthEmailEnqueueFailureSink,
  MemoryAuthEmailIntentStore,
  queueAuthEmail,
  smtpConfigFromEnvironment,
  type TransactionalEmailPort,
} from "./auth-email.js";
import { createCorrelationId, trustedCorrelationId } from "./http/correlation.js";

export interface AuthOptions {
  database?: BetterAuthOptions["database"];
  emailStore?: AuthEmailIntentStore;
  emailPort?: TransactionalEmailPort;
  emailFailureSink?: AuthEmailEnqueueFailureSink;
  emailEnqueueMaxAttempts?: number;
  baseURL?: string;
  trustedOrigins?: string[];
  trustedProxies?: string[];
  secret?: string;
  /** Injectable status lookup keeps auth tests independent of platform schema. */
  platformAccountStatus?: (userId: string) => Promise<"active" | "suspended" | null>;
}

function envList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

function originOf(value: string): string {
  return new URL(value).origin;
}

function isValidProxyEntry(value: string): boolean {
  const parts = value.split("/");
  if (parts.length > 2) return false;
  const [address, prefix] = parts;
  const version = address ? isIP(address) : 0;
  if (!version) return false;
  if (prefix === undefined) return true;
  if (!/^\d+$/.test(prefix)) return false;
  const size = version === 4 ? 32 : 128;
  const numericPrefix = Number(prefix);
  return numericPrefix >= 0 && numericPrefix <= size;
}

export function defaultTrustedProxies(): string[] {
  const configured = envList(
    process.env.CASEI_TRUSTED_PROXIES ?? process.env.BETTER_AUTH_TRUSTED_PROXIES,
  );
  const invalid = configured.filter((entry) => !isValidProxyEntry(entry));
  if (invalid.length > 0) {
    throw new Error(`Invalid trusted proxy CIDR configuration: ${invalid.join(", ")}`);
  }
  return configured;
}

export function defaultAuthIpAddressOptions(trustedProxies = defaultTrustedProxies()) {
  // Without an explicitly trusted reverse proxy, do not read any client-
  // supplied forwarding header. Better Auth falls back to a shared bucket in
  // production, which is safer than allowing an attacker to rotate IPs.
  if (trustedProxies.length === 0) return { ipAddressHeaders: [] as string[] };
  const headers = envList(process.env.CASEI_CLIENT_IP_HEADERS);
  return {
    ipAddressHeaders: headers.length > 0 ? headers : ["x-forwarded-for"],
    trustedProxies,
  };
}

export function defaultAuthOrigins(): string[] {
  const apiOrigin = process.env.BETTER_AUTH_URL
    ? originOf(process.env.BETTER_AUTH_URL)
    : process.env.CASEI_API_ORIGIN
      ? originOf(process.env.CASEI_API_ORIGIN)
      : "http://localhost:3001";
  const webOrigin = process.env.CASEI_WEB_ORIGIN
    ? originOf(process.env.CASEI_WEB_ORIGIN)
    : "http://localhost:3000";
  return [...new Set([...envList(process.env.CASEI_AUTH_TRUSTED_ORIGINS), apiOrigin, webOrigin])];
}

export function isAllowedAuthOrigin(
  origin: string | undefined,
  origins = defaultAuthOrigins(),
): boolean {
  if (!origin) return false;
  try {
    return origins.includes(originOf(origin));
  } catch {
    return false;
  }
}

/** Reject redirect input before Better Auth creates a user or queues work. */
export async function validateAuthCallbackRequest(
  request: Request,
  origins = defaultAuthOrigins(),
): Promise<Response | null> {
  if (request.method !== "POST") return null;
  const pathname = new URL(request.url).pathname;
  if (
    ![
      "/api/auth/sign-up/email",
      "/api/auth/request-password-reset",
      "/api/auth/send-verification-email",
    ].includes(pathname)
  ) {
    return null;
  }

  let body: { callbackURL?: unknown; redirectTo?: unknown };
  try {
    body = (await request.clone().json()) as { callbackURL?: unknown; redirectTo?: unknown };
  } catch {
    return null;
  }
  const callback = body.callbackURL ?? body.redirectTo;
  const isRelativeCallback =
    typeof callback === "string" && callback.startsWith("/") && !callback.startsWith("//");
  if (typeof callback !== "string" || isRelativeCallback) return null;
  if (!isAllowedAuthOrigin(callback, origins)) {
    return Response.json(
      { message: "Invalid callbackURL", code: "INVALID_CALLBACK_URL" },
      { status: 403 },
    );
  }
  return null;
}

function nestedCallbackUrl(url: string): string | null {
  try {
    return new URL(url).searchParams.get("callbackURL");
  } catch {
    return null;
  }
}

function assertCallbackUrlAllowlist(url: string, origins: string[]): string | null {
  const outer = new URL(url);
  if (!origins.includes(outer.origin)) throw new Error("Auth callback URL is not allowlisted");
  const callbackURL = nestedCallbackUrl(url);
  const isRelativeCallback = callbackURL?.startsWith("/") && !callbackURL.startsWith("//");
  if (callbackURL && !isRelativeCallback && !isAllowedAuthOrigin(callbackURL, origins)) {
    throw new Error("Auth callback URL is not allowlisted");
  }
  return callbackURL;
}

function authCorrelationId(request?: Request): string {
  return trustedCorrelationId(request?.headers.get("x-correlation-id") ?? createCorrelationId());
}

function makeAuthMessage(
  kind: AuthEmailKind,
  data: { user: { id: string; email: string }; url: string; token: string },
  request: Request | undefined,
  origins: string[],
  expiresIn: number,
): AuthEmailMessage {
  const callbackUrl = assertCallbackUrlAllowlist(data.url, origins);
  const expiresAt = new Date(Date.now() + expiresIn * 1000);
  return {
    kind,
    userId: data.user.id,
    email: data.user.email,
    url: data.url,
    token: data.token,
    callbackUrl,
    correlationId: authCorrelationId(request),
    expiresAt,
    sourceId: createHash("sha256").update(`${kind}\0${data.token}`).digest("hex"),
  };
}

export function createAuth(options: AuthOptions = {}) {
  const baseURL = options.baseURL ?? process.env.BETTER_AUTH_URL ?? "http://localhost:3001";
  const origins = options.trustedOrigins ?? defaultAuthOrigins();
  const secret = options.secret ?? process.env.BETTER_AUTH_SECRET;
  const isProduction = process.env.NODE_ENV === "production";

  if (isProduction && !secret) {
    throw new Error("BETTER_AUTH_SECRET is required in production");
  }

  const applicationDatabase = options.database ? undefined : createDatabase();
  const database =
    options.database ??
    drizzleAdapter(applicationDatabase as NonNullable<typeof applicationDatabase>, {
      provider: "pg",
    });
  const platformStatus =
    options.platformAccountStatus ??
    (applicationDatabase
      ? async (userId: string): Promise<"active" | "suspended" | null> => {
          const rows = await applicationDatabase.execute<{ status: string | null }>(
            sql`SELECT app.platform_status_for_user(${userId}) AS status`,
          );
          const status = rows.rows[0]?.status;
          return status === "active" || status === "suspended" ? status : null;
        }
      : undefined);
  const emailStore =
    options.emailStore ??
    (options.database
      ? new MemoryAuthEmailIntentStore()
      : new DrizzleAuthEmailIntentStore(
          applicationDatabase as NonNullable<typeof applicationDatabase>,
          secret ?? "development-only-secret",
        ));
  const emailFailureSink =
    options.emailFailureSink ??
    (isProduction
      ? new FileAuthEmailEnqueueFailureSink(
          process.env.CASEI_AUTH_EMAIL_RECOVERY_SPOOL ??
            "/var/lib/casei/auth-email-recovery.ndjson",
          secret ?? "development-only-secret",
        )
      : new LoggingAuthEmailEnqueueFailureSink());
  // The API process only persists intents. The worker constructs the actual
  // transport; production still validates its SMTP configuration at startup.
  if (isProduction) smtpConfigFromEnvironment();

  const queueEmail = async (
    kind: AuthEmailKind,
    data: { user: { id: string; email: string }; url: string; token: string },
    request: Request | undefined,
    expiresIn: number,
  ) => {
    const message = makeAuthMessage(kind, data, request, origins, expiresIn);
    await queueAuthEmail(emailStore, message, emailFailureSink, {
      maxAttempts: options.emailEnqueueMaxAttempts,
    });
  };

  return betterAuth({
    database,
    baseURL,
    basePath: "/api/auth",
    secret,
    plugins: [
      twoFactor({
        issuer: process.env.CASEI_APP_NAME ?? "Casei",
        twoFactorCookieMaxAge: 10 * 60,
        accountLockout: {
          enabled: true,
          maxFailedAttempts: 5,
          durationSeconds: 15 * 60,
        },
      }),
    ],
    databaseHooks: platformStatus
      ? {
          session: {
            create: {
              before: async (data) => {
                if ((await platformStatus(data.userId)) === "suspended") {
                  throw APIError.from("FORBIDDEN", {
                    code: "SUSPENDED_ACCOUNT",
                    message: "Suspended platform accounts cannot create sessions",
                  });
                }
              },
            },
          },
        }
      : undefined,
    trustedOrigins: origins,
    advanced: {
      ipAddress: defaultAuthIpAddressOptions(options.trustedProxies),
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      sendResetPassword: async (data, request) => {
        await queueEmail("password_reset", data, request, 60 * 60);
      },
      resetPasswordTokenExpiresIn: 60 * 60,
      revokeSessionsOnPasswordReset: true,
    },
    user: {
      changeEmail: {
        enabled: true,
        updateEmailWithoutVerification: false,
        sendChangeEmailConfirmation: async (data, request) => {
          await queueEmail("verification", data, request, 60 * 60);
        },
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      sendVerificationEmail: async (data, request) => {
        await queueEmail("verification", data, request, 60 * 60);
      },
      expiresIn: 60 * 60,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      preserveSessionInDatabase: true,
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      customRules: {
        "/sign-up/email": { window: 60, max: 5 },
        "/sign-in/email": { window: 60, max: 10 },
        "/request-password-reset": { window: 60, max: 5 },
        "/send-verification-email": { window: 60, max: 5 },
        "/reset-password": { window: 60, max: 10 },
      },
    },
  });
}

export const auth = createAuth();
