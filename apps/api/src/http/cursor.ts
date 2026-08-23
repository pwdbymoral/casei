import { createHmac, timingSafeEqual } from "node:crypto";

export interface CursorPayload {
  ordering: string;
  position: unknown;
}

interface SignedCursorPayload extends CursorPayload {
  version: 1;
}

export class InvalidCursorError extends Error {
  constructor(message = "Invalid cursor") {
    super(message);
    this.name = "InvalidCursorError";
  }
}

export function encodeCursor(payload: CursorPayload, secret: string): string {
  assertSecret(secret);
  if (payload.ordering.trim().length === 0) {
    throw new InvalidCursorError();
  }
  const value: SignedCursorPayload = { version: 1, ...payload };
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch (cause) {
    throw new InvalidCursorError(`Unable to encode cursor: ${String(cause)}`);
  }

  const encodedPayload = Buffer.from(serialized).toString("base64url");
  const signature = sign(encodedPayload, secret);
  return `${encodedPayload}.${signature}`;
}

export function decodeCursor(cursor: string, secret: string): CursorPayload {
  assertSecret(secret);
  const [encodedPayload, encodedSignature, ...extra] = cursor.split(".");
  if (!encodedPayload || !encodedSignature || extra.length > 0) {
    throw new InvalidCursorError();
  }

  const expectedSignature = Buffer.from(sign(encodedPayload, secret));
  const receivedSignature = Buffer.from(encodedSignature);
  if (
    expectedSignature.length !== receivedSignature.length ||
    !timingSafeEqual(expectedSignature, receivedSignature)
  ) {
    throw new InvalidCursorError();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    throw new InvalidCursorError();
  }

  if (!isSignedCursorPayload(parsed)) {
    throw new InvalidCursorError();
  }
  return { ordering: parsed.ordering, position: parsed.position };
}

function sign(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function assertSecret(secret: string): void {
  if (secret.length < 16) {
    throw new Error("Cursor secret must contain at least 16 characters");
  }
}

function isSignedCursorPayload(value: unknown): value is SignedCursorPayload {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<SignedCursorPayload>;
  return (
    candidate.version === 1 && typeof candidate.ordering === "string" && "position" in candidate
  );
}
