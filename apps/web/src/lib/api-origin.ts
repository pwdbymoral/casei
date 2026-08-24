export function configuredApiOrigin(): string | null {
  const origin = process.env.NEXT_PUBLIC_CASEI_API_ORIGIN?.trim();
  return origin ? origin.replace(/\/$/, "") : null;
}

export function requireApiOrigin(): string {
  const origin = configuredApiOrigin();
  if (!origin) {
    throw new Error("A origem da API do Casei não foi configurada.");
  }
  return origin;
}
