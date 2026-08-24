import { configuredApiOrigin } from "./api-origin";
import type { WorkspaceRole } from "./workspaces";

export type StockUnit = "unit" | "package" | "box" | "kg" | "g" | "L" | "ml" | "other";
export type StockState = "unknown" | "ok" | "low" | "missing";
export type StockMovementKind = "entry" | "consume" | "correction" | "discard";

export type StockProduct = {
  id: string;
  workspaceId: string;
  name: string;
  unit: StockUnit;
  unitLabel: string | null;
  quantity: string | null;
  minimum: string | null;
  markedMissing: boolean;
  state: StockState;
  category: string | null;
  location: string | null;
  note: string | null;
  archived: boolean;
  version: number;
};

export type StockMovement = {
  id: string;
  workspaceId: string;
  productId: string;
  kind: StockMovementKind;
  quantity: string;
  before: string | null;
  after: string | null;
  reason: string | null;
  authorId: string;
  occurredAt: string;
};

export type CreateStockProductInput = {
  name: string;
  unit?: StockUnit;
  unitLabel?: string | null;
  quantity?: string | null;
  minimum?: string | null;
  category?: string | null;
  location?: string | null;
  note?: string | null;
};

export type UpdateStockProductInput = {
  name: string;
  unit: StockUnit;
  unitLabel?: string | null;
  minimum?: string | null;
  category?: string | null;
  location?: string | null;
  note?: string | null;
};

export interface StockAdapter {
  listProducts(
    workspaceId: string,
    options?: { query?: string; includeArchived?: boolean },
  ): Promise<StockProduct[]>;
  /** One key belongs to one logical operation and is reused by its retries. */
  createProduct(
    workspaceId: string,
    input: CreateStockProductInput,
    idempotencyKey?: string,
  ): Promise<StockProduct>;
  updateProduct(
    workspaceId: string,
    product: StockProduct,
    input: UpdateStockProductInput,
  ): Promise<StockProduct>;
  createMovement(
    workspaceId: string,
    product: StockProduct,
    input: { kind: StockMovementKind; quantity: string; reason?: string | null },
    idempotencyKey?: string,
  ): Promise<{ product: StockProduct; movement: StockMovement }>;
  markMissing(
    workspaceId: string,
    product: StockProduct,
    missing: boolean,
    idempotencyKey?: string,
  ): Promise<StockProduct>;
  archive(
    workspaceId: string,
    product: StockProduct,
    idempotencyKey?: string,
  ): Promise<StockProduct>;
  restore(
    workspaceId: string,
    product: StockProduct,
    idempotencyKey?: string,
  ): Promise<StockProduct>;
  listMovements(workspaceId: string, productId: string): Promise<StockMovement[]>;
  readonly lastReadWasCached?: boolean;
}

export type StockAdapterErrorCode = "request_failed" | "offline_required";

export class StockAdapterError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly currentVersion?: number,
    readonly code: StockAdapterErrorCode = "request_failed",
  ) {
    super(message);
    this.name = "StockAdapterError";
  }
}

const unavailable: (...args: never[]) => Promise<never> = async () => {
  throw new StockAdapterError(
    "Seu estoque não está disponível. Entre novamente para continuar.",
    401,
  );
};

export const unauthenticatedStockAdapter: StockAdapter = {
  listProducts: unavailable,
  createProduct: unavailable,
  updateProduct: unavailable,
  createMovement: unavailable,
  markMissing: unavailable,
  archive: unavailable,
  restore: unavailable,
  listMovements: unavailable,
};

type JsonPage<T> = { items: T[]; page: { nextCursor: string | null; hasMore: boolean } };

const stockSnapshotPrefix = "casei:stock:snapshot:v1:";
let stockSnapshotGeneration = 0;

function stockStorage(): Storage | null {
  try {
    return typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

function stockSnapshotKey(
  workspaceId: string,
  options: { query?: string; includeArchived?: boolean },
): string {
  return `${stockSnapshotPrefix}${workspaceId}:${encodeURIComponent(
    JSON.stringify({
      query: options.query?.trim() ?? "",
      includeArchived: Boolean(options.includeArchived),
    }),
  )}`;
}

function readStockSnapshot(
  workspaceId: string,
  options: { query?: string; includeArchived?: boolean },
): StockProduct[] | null {
  const store = stockStorage();
  if (!store) return null;
  try {
    const value = store.getItem(stockSnapshotKey(workspaceId, options));
    if (!value) return null;
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as StockProduct[]) : null;
  } catch {
    return null;
  }
}

function writeStockSnapshot(
  workspaceId: string,
  options: { query?: string; includeArchived?: boolean },
  products: StockProduct[],
): void {
  try {
    stockStorage()?.setItem(stockSnapshotKey(workspaceId, options), JSON.stringify(products));
  } catch {
    // Storage is an enhancement; quota/security errors must not break online reads.
  }
}

/** Removes private snapshots when the authenticated workspace ends. */
export function clearStockOfflineSnapshot(workspaceId: string): void {
  stockSnapshotGeneration += 1;
  const store = stockStorage();
  if (!store) return;
  const prefix = `${stockSnapshotPrefix}${workspaceId}:`;
  try {
    for (let index = store.length - 1; index >= 0; index -= 1) {
      const key = store.key(index);
      if (key?.startsWith(prefix)) store.removeItem(key);
    }
  } catch {
    // A storage implementation may become unavailable during logout/navigation.
  }
}

/** Removes every private stock snapshot on logout, revocation, or scope reset. */
export function clearAllStockOfflineSnapshots(): void {
  stockSnapshotGeneration += 1;
  const store = stockStorage();
  if (!store) return;
  try {
    for (let index = store.length - 1; index >= 0; index -= 1) {
      const key = store.key(index);
      if (key?.startsWith(stockSnapshotPrefix)) store.removeItem(key);
    }
  } catch {
    // A storage implementation may become unavailable during logout/navigation.
  }
}

export function createHttpStockAdapter(
  options: { baseUrl?: string; fetch?: typeof globalThis.fetch } = {},
): StockAdapter {
  const request = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? "";
  let lastReadWasCached = false;

  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (init.body) headers.set("Content-Type", "application/json");
    const method = (init.method ?? "GET").toUpperCase();
    if (method !== "GET" && globalThis.navigator?.onLine === false) {
      throw new StockAdapterError(
        "Esta ação precisa de conexão.",
        undefined,
        undefined,
        "offline_required",
      );
    }
    let response: Response;
    try {
      response = await request(`${baseUrl}/v1${path}`, {
        ...init,
        headers,
        credentials: "include",
      });
    } catch {
      throw new StockAdapterError(
        "Esta ação precisa de conexão.",
        undefined,
        undefined,
        "offline_required",
      );
    }
    const payload = (await response.json().catch(() => null)) as
      | T
      | { error?: { message?: string; currentVersion?: number } }
      | null;
    if (!response.ok) {
      const error =
        payload && typeof payload === "object" && "error" in payload ? payload.error : undefined;
      throw new StockAdapterError(
        error?.message ?? "Não foi possível atualizar o estoque.",
        response.status,
        error?.currentVersion,
      );
    }
    return payload as T;
  }
  const key = () => `stock-${globalThis.crypto.randomUUID()}`;
  const path = (workspaceId: string, suffix = "") =>
    `/workspaces/${encodeURIComponent(workspaceId)}/stock/products${suffix}`;
  return {
    get lastReadWasCached() {
      return lastReadWasCached;
    },
    async listProducts(workspaceId, options = {}) {
      const requestSnapshotGeneration = stockSnapshotGeneration;
      const params = new URLSearchParams();
      if (options.query) params.set("query", options.query);
      if (options.includeArchived) params.set("includeArchived", "true");
      const query = params.toString();
      try {
        const products = (
          await call<JsonPage<StockProduct>>(`${path(workspaceId)}${query ? `?${query}` : ""}`)
        ).items;
        if (requestSnapshotGeneration === stockSnapshotGeneration) {
          writeStockSnapshot(workspaceId, options, products);
        }
        lastReadWasCached = false;
        return products;
      } catch (error) {
        const cached =
          error instanceof StockAdapterError && error.code === "offline_required"
            ? readStockSnapshot(workspaceId, options)
            : null;
        if (cached) {
          lastReadWasCached = true;
          return cached;
        }
        lastReadWasCached = false;
        throw error;
      }
    },
    createProduct: (workspaceId, input, commandKey) =>
      call<StockProduct>(path(workspaceId), {
        method: "POST",
        headers: { "Idempotency-Key": commandKey ?? key() },
        body: JSON.stringify(input),
      }),
    updateProduct: (workspaceId, product, input) =>
      call<StockProduct>(path(workspaceId, `/${product.id}`), {
        method: "PATCH",
        headers: { "If-Match": `"v${product.version}"` },
        body: JSON.stringify(input),
      }),
    async createMovement(workspaceId, product, input, commandKey) {
      return call<{ product: StockProduct; movement: StockMovement }>(
        path(workspaceId, `/${product.id}/movements`),
        {
          method: "POST",
          headers: {
            "Idempotency-Key": commandKey ?? key(),
            "If-Match": `"v${product.version}"`,
          },
          body: JSON.stringify(input),
        },
      );
    },
    markMissing: (workspaceId, product, missing, commandKey) =>
      call<StockProduct>(path(workspaceId, `/${product.id}/missing`), {
        method: "POST",
        headers: {
          "Idempotency-Key": commandKey ?? key(),
          "If-Match": `"v${product.version}"`,
        },
        body: JSON.stringify({ missing }),
      }),
    archive: (workspaceId, product, commandKey) =>
      call<StockProduct>(path(workspaceId, `/${product.id}/archive`), {
        method: "POST",
        headers: {
          "Idempotency-Key": commandKey ?? key(),
          "If-Match": `"v${product.version}"`,
        },
      }),
    restore: (workspaceId, product, commandKey) =>
      call<StockProduct>(path(workspaceId, `/${product.id}/restore`), {
        method: "POST",
        headers: {
          "Idempotency-Key": commandKey ?? key(),
          "If-Match": `"v${product.version}"`,
        },
      }),
    async listMovements(workspaceId, productId) {
      return (await call<JsonPage<StockMovement>>(path(workspaceId, `/${productId}/movements`)))
        .items;
    },
  };
}

const fixtureWorkspaceIds = [
  "019b5d9e-3c12-7a01-8d47-7b5b5dd7a201",
  "019b5d9e-3c12-7a02-8d47-7b5b5dd7a202",
] as const;

function fixtureProductId(workspaceId: string, index: number): string {
  return `${workspaceId.slice(0, 18)}${String(index).padStart(2, "0")}-8d47-7b5b5dd7a2${String(index).padStart(2, "2")}`;
}

function fixtureSeed(workspaceId: string): StockProduct[] {
  const first = workspaceId === fixtureWorkspaceIds[0];
  return first
    ? [
        {
          id: fixtureProductId(workspaceId, 1),
          workspaceId,
          name: "Arroz integral",
          unit: "kg",
          unitLabel: null,
          quantity: "2",
          minimum: "1",
          markedMissing: false,
          state: "ok",
          category: "Despensa",
          location: "Armário",
          note: null,
          archived: false,
          version: 0,
        },
        {
          id: fixtureProductId(workspaceId, 2),
          workspaceId,
          name: "Leite",
          unit: "L",
          unitLabel: null,
          quantity: "0",
          minimum: "2",
          markedMissing: false,
          state: "missing",
          category: "Geladeira",
          location: null,
          note: null,
          archived: false,
          version: 0,
        },
        {
          id: fixtureProductId(workspaceId, 3),
          workspaceId,
          name: "Café",
          unit: "package",
          unitLabel: null,
          quantity: null,
          minimum: null,
          markedMissing: false,
          state: "unknown",
          category: null,
          location: null,
          note: null,
          archived: false,
          version: 0,
        },
      ]
    : [
        {
          id: fixtureProductId(workspaceId, 1),
          workspaceId,
          name: "Papel higiênico",
          unit: "package",
          unitLabel: null,
          quantity: "1",
          minimum: "2",
          markedMissing: false,
          state: "low",
          category: "Limpeza",
          location: null,
          note: null,
          archived: false,
          version: 0,
        },
      ];
}

export function createFixtureStockAdapter(): StockAdapter {
  const productsByWorkspace = new Map<string, StockProduct[]>(
    fixtureWorkspaceIds.map((id) => [id, fixtureSeed(id)]),
  );
  const movementsByProduct = new Map<string, StockMovement[]>();
  let sequence = 100;
  const getProducts = (workspaceId: string) => productsByWorkspace.get(workspaceId) ?? [];
  return {
    async listProducts(workspaceId, options = {}) {
      const query = options.query?.trim().toLocaleLowerCase("pt-BR");
      return getProducts(workspaceId)
        .filter(
          (product) =>
            (options.includeArchived || !product.archived) &&
            (!query || product.name.toLocaleLowerCase("pt-BR").includes(query)),
        )
        .map((product) => ({ ...product }));
    },
    async createProduct(workspaceId, input) {
      const name = input.name.trim().replace(/\s+/gu, " ");
      if (
        getProducts(workspaceId).some(
          (item) =>
            !item.archived &&
            item.name.toLocaleLowerCase("pt-BR") === name.toLocaleLowerCase("pt-BR"),
        )
      )
        throw new StockAdapterError("Já existe um produto ativo com esse nome.", 409);
      const value: StockProduct = {
        id: fixtureProductId(workspaceId, ++sequence),
        workspaceId,
        name,
        unit: input.unit ?? "unit",
        unitLabel: input.unitLabel ?? null,
        quantity: input.quantity ?? null,
        minimum: input.minimum ?? null,
        markedMissing: false,
        state: deriveFixtureState(input.quantity ?? null, input.minimum ?? null, false),
        category: input.category ?? null,
        location: input.location ?? null,
        note: input.note ?? null,
        archived: false,
        version: 0,
      };
      getProducts(workspaceId).push(value);
      return { ...value };
    },
    async updateProduct(_workspaceId, product, input) {
      const list = getProducts(product.workspaceId);
      const current = list.find((item) => item.id === product.id);
      if (!current) throw new StockAdapterError("Produto não encontrado.", 404);
      if (current.version !== product.version)
        throw new StockAdapterError("O produto foi alterado.", 412, current.version);
      Object.assign(current, {
        ...input,
        unitLabel: input.unitLabel ?? null,
        minimum: input.minimum ?? null,
        category: input.category ?? null,
        location: input.location ?? null,
        note: input.note ?? null,
        version: current.version + 1,
      });
      return { ...current };
    },
    async createMovement(_workspaceId, product, input) {
      const current = getProducts(product.workspaceId).find((item) => item.id === product.id);
      if (!current) throw new StockAdapterError("Produto não encontrado.", 404);
      if (current.version !== product.version)
        throw new StockAdapterError("O produto foi alterado.", 412, current.version);
      const before = current.quantity;
      const beforeMilli = before === null ? null : fixtureParseQuantity(before, true);
      const amountMilli = fixtureParseQuantity(input.quantity, input.kind === "correction");
      const afterMilli =
        input.kind === "correction"
          ? amountMilli
          : (beforeMilli ?? BigInt(0)) + (input.kind === "entry" ? amountMilli : -amountMilli);
      if (afterMilli < BigInt(0))
        throw new StockAdapterError("O consumo não pode deixar o estoque negativo.", 409);
      current.quantity = fixtureFormatQuantity(afterMilli);
      current.markedMissing = false;
      current.state = deriveFixtureState(current.quantity, current.minimum, false);
      current.version += 1;
      const movement: StockMovement = {
        id: fixtureProductId(product.workspaceId, ++sequence),
        workspaceId: product.workspaceId,
        productId: product.id,
        kind: input.kind,
        quantity: fixtureFormatQuantity(amountMilli),
        before,
        after: current.quantity,
        reason: input.reason ?? null,
        authorId: "user_fixture_marina",
        occurredAt: new Date().toISOString(),
      };
      const history = movementsByProduct.get(product.id) ?? [];
      history.unshift(movement);
      movementsByProduct.set(product.id, history);
      return { product: { ...current }, movement };
    },
    async markMissing(_workspaceId, product, missing) {
      return updateMark(getProducts(product.workspaceId), product, missing);
    },
    async archive(_workspaceId, product) {
      return updateArchive(getProducts(product.workspaceId), product, true);
    },
    async restore(_workspaceId, product) {
      return updateArchive(getProducts(product.workspaceId), product, false);
    },
    async listMovements(_workspaceId, productId) {
      return [...(movementsByProduct.get(productId) ?? [])];
    },
  };
}

function deriveFixtureState(
  quantity: string | null,
  minimum: string | null,
  markedMissing: boolean,
): StockState {
  if (markedMissing || quantity === "0") return "missing";
  if (quantity === null) return "unknown";
  if (
    minimum !== null &&
    fixtureParseQuantity(quantity, true) <= fixtureParseQuantity(minimum, true)
  )
    return "low";
  return "ok";
}
function updateMark(list: StockProduct[], product: StockProduct, missing: boolean): StockProduct {
  const current = list.find((item) => item.id === product.id);
  if (!current) throw new StockAdapterError("Produto não encontrado.", 404);
  if (current.version !== product.version)
    throw new StockAdapterError("O produto foi alterado.", 412, current.version);
  current.markedMissing = missing;
  current.state = deriveFixtureState(current.quantity, current.minimum, missing);
  current.version += 1;
  return { ...current };
}
function updateArchive(
  list: StockProduct[],
  product: StockProduct,
  archived: boolean,
): StockProduct {
  const current = list.find((item) => item.id === product.id);
  if (!current) throw new StockAdapterError("Produto não encontrado.", 404);
  if (current.version !== product.version)
    throw new StockAdapterError("O produto foi alterado.", 412, current.version);
  current.archived = archived;
  current.version += 1;
  return { ...current };
}

export function stockAdapterForEnvironment(options: { fixtures?: boolean } = {}): StockAdapter {
  if (
    process.env.NODE_ENV !== "production" &&
    (options.fixtures === true || process.env.CASEI_UI_FIXTURES === "1")
  )
    return createFixtureStockAdapter();
  const origin = configuredApiOrigin();
  return origin ? createHttpStockAdapter({ baseUrl: origin }) : unauthenticatedStockAdapter;
}

export function canWriteStock(role: WorkspaceRole): boolean {
  return role !== "viewer";
}
export const stockStateLabel: Record<StockState, string> = {
  unknown: "Sem quantidade",
  ok: "Em dia",
  low: "Baixo",
  missing: "Faltando",
};
export const stockUnitLabel: Record<StockUnit, string> = {
  unit: "unidade",
  package: "pacote",
  box: "caixa",
  kg: "kg",
  g: "g",
  L: "L",
  ml: "ml",
  other: "outra",
};

function fixtureParseQuantity(value: string, allowZero: boolean): bigint {
  const source = value.trim();
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,3})?$/.test(source))
    throw new StockAdapterError("Quantidade deve ter até três casas decimais.", 422);
  const [whole = "0", fraction = ""] = source.split(".");
  const milli = BigInt(whole) * BigInt(1000) + BigInt(fraction.padEnd(3, "0") || "0");
  if ((!allowZero && milli <= BigInt(0)) || milli > BigInt("999999999999999"))
    throw new StockAdapterError("Quantidade fora do limite.", 422);
  return milli;
}

function fixtureFormatQuantity(milli: bigint): string {
  const whole = milli / BigInt(1000);
  const fraction = (milli % BigInt(1000)).toString().padStart(3, "0").replace(/0+$/u, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
