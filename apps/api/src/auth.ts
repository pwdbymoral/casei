import { createHash } from "node:crypto";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { createDatabase } from "@casei/database";
import type { BetterAuthOptions } from "better-auth";
import { betterAuth } from "better-auth/minimal";
import {
  type AuthEmailIntentStore,
  type AuthEmailKind,
  type AuthEmailMessage,
  DrizzleAuthEmailIntentStore,
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
  baseURL?: string;
  trustedOrigins?: string[];
  secret?: string;
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
  const emailStore =
    options.emailStore ??
    (options.database
      ? new MemoryAuthEmailIntentStore()
      : new DrizzleAuthEmailIntentStore(
          applicationDatabase as NonNullable<typeof applicationDatabase>,
          secret ?? "development-only-secret",
        ));
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
    await queueAuthEmail(emailStore, message);
  };

  return betterAuth({
    database,
    baseURL,
    basePath: "/api/auth",
    secret,
    trustedOrigins: origins,
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      sendResetPassword: async (data, request) => {
        await queueEmail("password_reset", data, request, 60 * 60);
      },
      resetPasswordTokenExpiresIn: 60 * 60,
      revokeSessionsOnPasswordReset: true,
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
