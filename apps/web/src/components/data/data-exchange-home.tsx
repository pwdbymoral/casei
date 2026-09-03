"use client";

import {
  AlertCircleIcon,
  CheckCircle2Icon,
  CloudOffIcon,
  DownloadIcon,
  FileDownIcon,
  FileSpreadsheetIcon,
  FileUpIcon,
  LoaderCircleIcon,
  LockKeyholeIcon,
  PauseCircleIcon,
  RefreshCwIcon,
  UploadIcon,
  XIcon,
} from "lucide-react";
import { useSearchParams } from "next/navigation";
import type { ChangeEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AsyncState } from "@/components/primitives";
import { useAuthenticatedWorkspace } from "@/components/shell/app-shell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  beginDataExchangeOperation,
  canExportData,
  canImportData,
  type DataDomain,
  type DataExchangeAdapter,
  DataExchangeError,
  type DataExchangeOperationState,
  type DuplicatePolicy,
  dataExchangeAdapterForEnvironment,
  type ExportJob,
  exportHistorySurfaceStatus,
  exportStatusLabel,
  formatDataFileSize,
  type ImportApplyMode,
  type ImportJob,
  type ImportLocale,
  type ImportPreview,
  importStatusLabel,
  MAX_IMPORT_ROWS,
  serializeImportErrorReport,
} from "@/lib/data-exchange";

type SurfaceStatus = "idle" | "loading" | "success" | "error" | "offline" | "permission";

const domainLabels: Record<DataDomain, string> = {
  transactions: "Transações",
  products: "Produtos e estoque",
  complete: "Exportação completa",
};

function errorStatus(error: unknown): Exclude<SurfaceStatus, "idle" | "loading" | "success"> {
  if (error instanceof DataExchangeError) {
    if (error.code === "permission") return "permission";
    if (error.code === "offline") return "offline";
  }
  return "error";
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "Não foi possível concluir a operação. Tente novamente.";
}

function terminalImport(job: ImportJob | null): boolean {
  return Boolean(job && ["completed", "partial", "failed", "canceled"].includes(job.status));
}

function terminalExport(job: ExportJob | null): boolean {
  return Boolean(job && ["completed", "failed", "expired"].includes(job.status));
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function downloadErrorReport(job: ImportJob) {
  downloadBlob(
    new Blob([serializeImportErrorReport(job.errors)], { type: "text/csv;charset=utf-8" }),
    `casei-erros-${job.id}.csv`,
  );
}

function CountCard({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number;
  tone?: "default" | "warning" | "danger";
}) {
  return (
    <div className="rounded-lg border bg-background p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={
          tone === "danger"
            ? "mt-1 text-xl font-semibold text-destructive"
            : tone === "warning"
              ? "mt-1 text-xl font-semibold text-amber-700"
              : "mt-1 text-xl font-semibold"
        }
      >
        {value}
      </p>
    </div>
  );
}

function ProgressBar({ value, label }: { value: number; label: string }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span>{label}</span>
        <span className="text-muted-foreground">{value}%</span>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
      >
        <div
          className="h-full rounded-full bg-primary transition-[width]"
          style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
        />
      </div>
    </div>
  );
}

export function DataExchangeHome({ adapter: providedAdapter }: { adapter?: DataExchangeAdapter }) {
  const { workspaceId, role, fixtureMode } = useAuthenticatedWorkspace();
  const searchParams = useSearchParams();
  const adapter = useMemo(
    () => providedAdapter ?? dataExchangeAdapterForEnvironment({ fixtures: fixtureMode }),
    [fixtureMode, providedAdapter],
  );
  const [online, setOnline] = useState(true);
  const [file, setFile] = useState<File | null>(null);
  const [domain, setDomain] = useState<Exclude<DataDomain, "complete">>("transactions");
  const [locale, setLocale] = useState<ImportLocale>("pt-BR");
  const [sheetName, setSheetName] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [mappingDirty, setMappingDirty] = useState(false);
  const [previewStatus, setPreviewStatus] = useState<SurfaceStatus>("idle");
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [duplicatePolicy, setDuplicatePolicy] = useState<DuplicatePolicy>("ignore");
  const [applyMode, setApplyMode] = useState<ImportApplyMode>("valid_only");
  const [importJob, setImportJob] = useState<ImportJob | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importPending, setImportPending] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);
  const [retryPending, setRetryPending] = useState(false);
  const [exportJobs, setExportJobs] = useState<ExportJob[]>([]);
  const [exportStatus, setExportStatus] = useState<SurfaceStatus>("loading");
  const [exportPending, setExportPending] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportDomain, setExportDomain] = useState<DataDomain>(() =>
    searchParams.get("domain") === "products" || searchParams.get("domain") === "complete"
      ? (searchParams.get("domain") as DataDomain)
      : "transactions",
  );
  const [exportFormat, setExportFormat] = useState<"csv" | "zip">("csv");
  const [exportFrom, setExportFrom] = useState(() => searchParams.get("from") ?? "");
  const [exportTo, setExportTo] = useState(() => searchParams.get("to") ?? "");
  const [exportKind] = useState<"all" | "income" | "expense">(() => {
    const value = searchParams.get("kind");
    return value === "income" || value === "expense" ? value : "all";
  });
  const [exportCategoryId] = useState<string | null>(() => searchParams.get("categoryId") || null);
  const [activeExport, setActiveExport] = useState<ExportJob | null>(null);
  const importOperation = useRef<DataExchangeOperationState>({ pending: false, key: null });
  const cancelOperation = useRef<DataExchangeOperationState>({ pending: false, key: null });
  const retryOperation = useRef<DataExchangeOperationState>({ pending: false, key: null });
  const exportOperation = useRef<DataExchangeOperationState>({ pending: false, key: null });

  const importAllowed = canImportData(role);
  const exportAllowed = canExportData(role);
  const completeExportAllowed = role === "owner";

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  const loadExports = useCallback(async () => {
    setExportStatus("loading");
    setExportError(null);
    try {
      setExportJobs(await adapter.listExportJobs(workspaceId));
      setExportStatus("success");
    } catch (error) {
      setExportStatus(errorStatus(error));
      setExportError(errorMessage(error));
    }
  }, [adapter, workspaceId]);

  useEffect(() => {
    void loadExports();
  }, [loadExports]);

  useEffect(() => {
    if (!importJob || terminalImport(importJob)) return;
    let active = true;
    const poll = async () => {
      try {
        const next = await adapter.getImportJob(workspaceId, importJob.id);
        if (active) setImportJob(next);
      } catch (error) {
        if (active) setImportError(errorMessage(error));
      }
    };
    const timer = window.setInterval(() => void poll(), 700);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [adapter, importJob, workspaceId]);

  useEffect(() => {
    if (!activeExport || terminalExport(activeExport)) return;
    let active = true;
    const poll = async () => {
      try {
        const next = await adapter.getExportJob(workspaceId, activeExport.id);
        if (active) {
          setActiveExport(next);
          setExportJobs((current) => [next, ...current.filter((job) => job.id !== next.id)]);
        }
      } catch (error) {
        if (active) setExportError(errorMessage(error));
      }
    };
    const timer = window.setInterval(() => void poll(), 700);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [activeExport, adapter, workspaceId]);

  function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const next = event.target.files?.[0] ?? null;
    setFile(next);
    setPreview(null);
    setSheetName("");
    setMapping({});
    setMappingDirty(false);
    setPreviewStatus("idle");
    setPreviewError(null);
    setImportJob(null);
    setImportError(null);
    importOperation.current.key = null;
    cancelOperation.current.key = null;
    retryOperation.current.key = null;
  }

  async function previewFile() {
    if (!file || !importAllowed) return;
    setPreviewStatus("loading");
    setPreviewError(null);
    try {
      const next = await adapter.previewImport(workspaceId, {
        file,
        domain,
        locale,
        mapping,
        ...(sheetName.trim() ? { sheetName: sheetName.trim() } : {}),
      });
      setPreview(next);
      setMapping({ ...next.mapping });
      setMappingDirty(false);
      importOperation.current.key = null;
      setPreviewStatus("success");
    } catch (error) {
      setPreviewStatus(errorStatus(error));
      setPreviewError(errorMessage(error));
    }
  }

  function changeMapping(field: string, value: string) {
    setMapping((current) => ({ ...current, [field]: value }));
    importOperation.current.key = null;
    setMappingDirty(true);
    setPreviewStatus("success");
  }

  async function startImport() {
    if (!file || !preview || !canConfirmImport || !importAllowed || !online) return;
    const operation = beginDataExchangeOperation(
      importOperation.current,
      "import",
      () => crypto.randomUUID(),
      (key) =>
        adapter.startImport(
          workspaceId,
          { preview, file, mapping, duplicatePolicy, applyMode },
          key,
        ),
    );
    if (!operation.started) return;
    setImportPending(true);
    setImportError(null);
    setImportJob(null);
    try {
      setImportJob(await operation.promise);
    } catch (error) {
      setImportError(errorMessage(error));
    } finally {
      setImportPending(false);
    }
  }

  async function cancelImport() {
    if (!importJob || terminalImport(importJob)) return;
    const jobId = importJob.id;
    const operation = beginDataExchangeOperation(
      cancelOperation.current,
      "cancel",
      () => crypto.randomUUID(),
      (key) => adapter.cancelImport(workspaceId, jobId, key),
    );
    if (!operation.started) return;
    setCancelPending(true);
    try {
      setImportJob(await operation.promise);
    } catch (error) {
      setImportError(errorMessage(error));
    } finally {
      setCancelPending(false);
    }
  }

  async function retryImport() {
    if (!importJob || !online) return;
    const jobId = importJob.id;
    const operation = beginDataExchangeOperation(
      retryOperation.current,
      "retry",
      () => crypto.randomUUID(),
      (key) => adapter.retryImport(workspaceId, jobId, key),
    );
    if (!operation.started) return;
    setRetryPending(true);
    try {
      setImportError(null);
      setImportJob(await operation.promise);
    } catch (error) {
      setImportError(errorMessage(error));
    } finally {
      setRetryPending(false);
    }
  }

  async function createExport() {
    if (!exportAllowed || (exportDomain === "complete" && !completeExportAllowed) || !online)
      return;
    const operation = beginDataExchangeOperation(
      exportOperation.current,
      "export",
      () => crypto.randomUUID(),
      (key) =>
        adapter.createExport(
          workspaceId,
          {
            domain: exportDomain,
            format: exportFormat,
            from: exportFrom || undefined,
            to: exportTo || undefined,
            kind: exportKind,
            categoryId: exportCategoryId,
          },
          key,
        ),
    );
    if (!operation.started) return;
    setExportPending(true);
    setExportError(null);
    try {
      const next = await operation.promise;
      setActiveExport(next);
      setExportJobs((current) => [next, ...current.filter((job) => job.id !== next.id)]);
    } catch (error) {
      setExportStatus(errorStatus(error));
      setExportError(errorMessage(error));
    } finally {
      setExportPending(false);
    }
  }

  async function downloadExport(job: ExportJob) {
    if (!online || job.status !== "completed") return;
    try {
      const blob = await adapter.downloadExport(workspaceId, job.id);
      downloadBlob(blob, job.fileName ?? `casei-${job.domain}.${job.format}`);
    } catch (error) {
      setExportError(errorMessage(error));
    }
  }

  const importMessage = importJob
    ? importStatusLabel(importJob.status)
    : previewStatus === "loading"
      ? "Preparando prévia…"
      : "";
  const canConfirmImport = Boolean(
    preview?.canConfirm === true &&
      (preview.serverBacked || fixtureMode) &&
      !mappingDirty &&
      (applyMode === "valid_only" || preview.counts.errors === 0),
  );
  const exportSurfaceStatus = exportHistorySurfaceStatus(
    exportStatus === "idle" ? "loading" : exportStatus,
    exportJobs.length > 0,
  );

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6 lg:py-10">
      <header className="flex flex-col gap-2">
        <p className="text-sm font-medium text-primary">Dados</p>
        <h1 className="font-heading text-3xl font-semibold tracking-tight">Importar e exportar</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Traga seus dados para o Casei ou baixe uma cópia reimportável. Toda importação passa por
          uma prévia antes de alterar o espaço.
        </p>
      </header>

      {!online ? (
        <Alert>
          <CloudOffIcon aria-hidden="true" />
          <AlertTitle>Você está offline</AlertTitle>
          <AlertDescription>
            É possível revisar o arquivo localmente, mas confirmar importações e gerar downloads
            exige conexão.
          </AlertDescription>
        </Alert>
      ) : null}

      {exportStatus === "error" || exportStatus === "offline" ? (
        <Alert variant="destructive">
          <AlertCircleIcon aria-hidden="true" />
          <AlertTitle>Exportações anteriores indisponíveis</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-3">
            <span>{exportError}</span>
            <Button type="button" variant="outline" size="sm" onClick={() => void loadExports()}>
              <RefreshCwIcon data-icon="inline-start" aria-hidden="true" /> Tentar novamente
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {!importAllowed ? (
        <Alert>
          <LockKeyholeIcon aria-hidden="true" />
          <AlertTitle>Importação restrita</AlertTitle>
          <AlertDescription>
            Seu papel de leitor permite exportar os dados que você pode visualizar, mas não importar
            alterações.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(22rem,0.9fr)]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileUpIcon aria-hidden="true" /> Importar dados
            </CardTitle>
            <CardDescription>
              CSV e XLSX, até 10 MB e 50 mil linhas. O arquivo original não é armazenado pela
              prévia.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="import-domain">O que você quer importar?</FieldLabel>
                <select
                  id="import-domain"
                  className="min-h-11 rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                  value={domain}
                  disabled={!importAllowed || importPending || importJob?.status === "processing"}
                  onChange={(event) => {
                    setDomain(event.target.value as typeof domain);
                    setPreview(null);
                    importOperation.current.key = null;
                  }}
                >
                  <option value="transactions">Transações</option>
                  <option value="products">Produtos e estoque</option>
                </select>
              </Field>
              <Field>
                <FieldLabel htmlFor="import-file">Arquivo</FieldLabel>
                <Input
                  id="import-file"
                  type="file"
                  accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  className="min-h-11 cursor-pointer py-2"
                  disabled={!importAllowed || importPending || importJob?.status === "processing"}
                  onChange={chooseFile}
                />
                <FieldDescription>
                  CSV UTF-8/Latin-1 ou XLSX sem macros. Limite: 10 MB.
                </FieldDescription>
              </Field>
              {file ? (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/30 p-3 text-sm">
                  <div className="flex min-w-0 items-center gap-2">
                    <FileSpreadsheetIcon aria-hidden="true" />
                    <span className="truncate font-medium">{file.name}</span>
                    <span className="text-muted-foreground">{formatDataFileSize(file.size)}</span>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setFile(null);
                      setPreview(null);
                      setPreviewStatus("idle");
                      importOperation.current.key = null;
                      retryOperation.current.key = null;
                    }}
                  >
                    <XIcon data-icon="inline-start" aria-hidden="true" /> Remover
                  </Button>
                </div>
              ) : null}
              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="import-locale">Formato de data</FieldLabel>
                  <select
                    id="import-locale"
                    className="min-h-11 rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                    value={locale}
                    disabled={!importAllowed}
                    onChange={(event) => {
                      setLocale(event.target.value as ImportLocale);
                      setPreview(null);
                      importOperation.current.key = null;
                    }}
                  >
                    <option value="pt-BR">Brasil (dd/mm/aaaa)</option>
                    <option value="en-US">Estados Unidos (mm/dd/aaaa)</option>
                  </select>
                </Field>
                {file?.name.toLocaleLowerCase("en-US").endsWith(".xlsx") ? (
                  <Field>
                    <FieldLabel htmlFor="import-sheet-name">Planilha (opcional)</FieldLabel>
                    <Input
                      id="import-sheet-name"
                      value={sheetName}
                      placeholder="Nome da planilha"
                      disabled={
                        !importAllowed || importPending || importJob?.status === "processing"
                      }
                      onChange={(event) => {
                        setSheetName(event.target.value);
                        setPreview(null);
                        importOperation.current.key = null;
                      }}
                    />
                    <FieldDescription>
                      Se o arquivo tiver mais de uma planilha, informe o nome exibido no erro da
                      prévia.
                    </FieldDescription>
                  </Field>
                ) : null}
                <div className="flex items-end">
                  <Button
                    type="button"
                    className="min-h-11 w-full"
                    disabled={
                      !file || !importAllowed || importPending || previewStatus === "loading"
                    }
                    onClick={() => void previewFile()}
                  >
                    {previewStatus === "loading" ? (
                      <LoaderCircleIcon
                        data-icon="inline-start"
                        className="animate-spin"
                        aria-hidden="true"
                      />
                    ) : (
                      <UploadIcon data-icon="inline-start" aria-hidden="true" />
                    )}
                    {preview ? "Atualizar prévia" : "Preparar prévia"}
                  </Button>
                </div>
              </div>
            </FieldGroup>

            {previewStatus === "error" ||
            previewStatus === "offline" ||
            previewStatus === "permission" ? (
              <AsyncState
                status={previewStatus}
                description={previewError ?? undefined}
                action={{ label: "Tentar novamente", onClick: () => void previewFile() }}
              />
            ) : null}

            {preview ? (
              <section
                className="flex flex-col gap-5 border-t pt-5"
                aria-labelledby="preview-heading"
              >
                <div className="flex flex-col gap-1">
                  <h2 id="preview-heading" className="font-semibold">
                    Prévia antes de importar
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    {preview.serverBacked
                      ? "Validação do servidor concluída."
                      : !online
                        ? "Prévia local para revisar o formato; a validação canônica acontece no servidor."
                        : "Esta prévia local precisa ser atualizada com o servidor antes de confirmar."}
                  </p>
                </div>
                {preview.message ? (
                  <Alert>
                    <AlertCircleIcon aria-hidden="true" />
                    <AlertDescription>{preview.message}</AlertDescription>
                  </Alert>
                ) : null}
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <CountCard label="Válidas" value={preview.counts.valid} />
                  <CountCard label="Avisos" value={preview.counts.warnings} tone="warning" />
                  <CountCard
                    label="Duplicatas sugeridas"
                    value={preview.counts.duplicates}
                    tone="warning"
                  />
                  <CountCard label="Erros" value={preview.counts.errors} tone="danger" />
                </div>
                {preview.fields.length > 0 && preview.headers.length > 0 ? (
                  <FieldSet>
                    <FieldLegend variant="label">Mapeamento das colunas</FieldLegend>
                    <FieldDescription>
                      Confira as sugestões. Colunas não mapeadas são mantidas como aviso e não
                      entram nos registros.
                    </FieldDescription>
                    <div className="flex flex-col gap-3">
                      {preview.fields.map((field) => (
                        <Field key={field.key} orientation="responsive">
                          <FieldLabel htmlFor={`mapping-${field.key}`}>
                            {field.label}
                            {field.required ? " (obrigatório)" : null}
                          </FieldLabel>
                          <select
                            id={`mapping-${field.key}`}
                            className="min-h-11 rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                            value={mapping[field.key] ?? ""}
                            onChange={(event) => changeMapping(field.key, event.target.value)}
                          >
                            <option value="">Não mapear</option>
                            {preview.headers.map((header) => (
                              <option key={header} value={header}>
                                {header}
                              </option>
                            ))}
                          </select>
                        </Field>
                      ))}
                    </div>
                    {mappingDirty ? (
                      <Alert>
                        <AlertCircleIcon aria-hidden="true" />
                        <AlertDescription>
                          O mapeamento mudou. Atualize a prévia para validar as linhas com essas
                          colunas.
                        </AlertDescription>
                      </Alert>
                    ) : null}
                  </FieldSet>
                ) : null}
                {preview.rows.length > 0 ? (
                  <div className="flex flex-col gap-2">
                    <p className="text-sm font-medium">Primeiras linhas</p>
                    <section
                      className="overflow-x-auto rounded-lg border"
                      aria-label="Prévia tabular"
                    >
                      <table className="w-full min-w-[36rem] text-left text-sm">
                        <thead className="bg-muted/50 text-xs text-muted-foreground">
                          <tr>
                            <th scope="col" className="px-3 py-2">
                              Linha
                            </th>
                            {preview.headers.slice(0, 6).map((header) => (
                              <th scope="col" key={header} className="px-3 py-2">
                                {header}
                              </th>
                            ))}
                            <th scope="col" className="px-3 py-2">
                              Resultado
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {preview.rows.slice(0, 10).map((row) => (
                            <tr key={row.rowNumber} className="border-t align-top">
                              <th scope="row" className="px-3 py-2 font-medium">
                                {row.rowNumber}
                              </th>
                              {row.cells.slice(0, 6).map((cell, index) => (
                                <td
                                  key={`${row.rowNumber}-${preview.headers[index] ?? "column"}`}
                                  className="max-w-48 px-3 py-2"
                                >
                                  <span className="block truncate" title={cell}>
                                    {cell || "—"}
                                  </span>
                                </td>
                              ))}
                              <td className="px-3 py-2">
                                {row.status === "valid" ? (
                                  <Badge variant="secondary">Válida</Badge>
                                ) : row.status === "duplicate" ? (
                                  <Badge variant="outline">Duplicata sugerida</Badge>
                                ) : (
                                  <Badge variant="destructive">Erro</Badge>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </section>
                    {preview.rows.length > 10 ? (
                      <p className="text-xs text-muted-foreground">
                        {preview.rowLimitExceeded
                          ? `A prévia foi limitada a ${MAX_IMPORT_ROWS.toLocaleString("pt-BR")} linhas. Reduza o arquivo para confirmar a importação.`
                          : `Mostrando 10 linhas; o job processará todas as ${preview.rows.length} linhas da prévia.`}
                      </p>
                    ) : null}
                  </div>
                ) : null}
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor="duplicate-policy">
                      Se houver duplicatas prováveis
                    </FieldLabel>
                    <select
                      id="duplicate-policy"
                      className="min-h-11 rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                      value={duplicatePolicy}
                      onChange={(event) => {
                        setDuplicatePolicy(event.target.value as DuplicatePolicy);
                        importOperation.current.key = null;
                      }}
                    >
                      <option value="ignore">Ignorar e registrar</option>
                      <option value="import">Importar mesmo assim</option>
                      <option value="review">Parar para revisar</option>
                    </select>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="import-mode">Se houver erros de linha</FieldLabel>
                    <select
                      id="import-mode"
                      className="min-h-11 rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                      value={applyMode}
                      onChange={(event) => {
                        setApplyMode(event.target.value as ImportApplyMode);
                        importOperation.current.key = null;
                      }}
                    >
                      <option value="valid_only">Importar somente válidas</option>
                      <option value="all_or_nothing">Tudo ou nada</option>
                    </select>
                  </Field>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    type="button"
                    className="min-h-11"
                    disabled={
                      !canConfirmImport ||
                      !importAllowed ||
                      importPending ||
                      !online ||
                      Boolean(importJob && !terminalImport(importJob))
                    }
                    onClick={() => void startImport()}
                  >
                    <CheckCircle2Icon data-icon="inline-start" aria-hidden="true" /> Confirmar
                    importação
                  </Button>
                  {previewStatus === "success" && !canConfirmImport ? (
                    <span className="text-sm text-muted-foreground">
                      {!preview.serverBacked && !fixtureMode
                        ? "Atualize a prévia com o servidor antes de confirmar."
                        : applyMode === "all_or_nothing" && preview.counts.errors > 0
                          ? "Corrija os erros ou escolha importar somente as linhas válidas."
                          : "Corrija os campos obrigatórios e atualize a prévia para confirmar."}
                    </span>
                  ) : null}
                </div>
              </section>
            ) : (
              <Empty className="min-h-36 border">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <FileSpreadsheetIcon aria-hidden="true" />
                  </EmptyMedia>
                  <EmptyTitle>Escolha um arquivo para começar</EmptyTitle>
                  <EmptyDescription>
                    Você verá o mapeamento e as linhas antes de qualquer alteração no espaço.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}

            {importJob ? (
              <section
                className="flex flex-col gap-4 border-t pt-5"
                aria-labelledby="import-job-heading"
                aria-live="polite"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 id="import-job-heading" className="font-semibold">
                      Aplicação da importação
                    </h2>
                    <p className="text-sm text-muted-foreground">{importMessage}</p>
                  </div>
                  <Badge variant={importJob.status === "failed" ? "destructive" : "secondary"}>
                    {importStatusLabel(importJob.status)}
                  </Badge>
                </div>
                <ProgressBar
                  value={importJob.progress}
                  label={`${importJob.appliedRows} de ${importJob.totalRows} linhas aplicadas`}
                />
                <div className="grid grid-cols-3 gap-3 text-sm">
                  <div>
                    <span className="block text-muted-foreground">Aplicadas</span>
                    <strong>{importJob.appliedRows}</strong>
                  </div>
                  <div>
                    <span className="block text-muted-foreground">Ignoradas</span>
                    <strong>{importJob.ignoredRows}</strong>
                  </div>
                  <div>
                    <span className="block text-muted-foreground">Rejeitadas</span>
                    <strong>{importJob.rejectedRows}</strong>
                  </div>
                </div>
                {importJob.message ? (
                  <Alert>
                    <AlertCircleIcon aria-hidden="true" />
                    <AlertDescription>{importJob.message}</AlertDescription>
                  </Alert>
                ) : null}
                {importError ? (
                  <Alert variant="destructive">
                    <AlertCircleIcon aria-hidden="true" />
                    <AlertDescription>{importError}</AlertDescription>
                  </Alert>
                ) : null}
                <div className="flex flex-wrap gap-3">
                  {!terminalImport(importJob) ? (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={cancelPending}
                      aria-busy={cancelPending}
                      onClick={() => void cancelImport()}
                    >
                      {cancelPending ? (
                        <LoaderCircleIcon
                          data-icon="inline-start"
                          className="animate-spin"
                          aria-hidden="true"
                        />
                      ) : (
                        <PauseCircleIcon data-icon="inline-start" aria-hidden="true" />
                      )}
                      {cancelPending ? "Cancelando…" : "Cancelar job"}
                    </Button>
                  ) : null}
                  {importJob.status === "failed" || importJob.status === "canceled" ? (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={!online || retryPending}
                      onClick={() => void retryImport()}
                    >
                      {retryPending ? (
                        <LoaderCircleIcon
                          data-icon="inline-start"
                          className="animate-spin"
                          aria-hidden="true"
                        />
                      ) : (
                        <RefreshCwIcon data-icon="inline-start" aria-hidden="true" />
                      )}{" "}
                      {retryPending ? "Tentando novamente…" : "Tentar novamente"}
                    </Button>
                  ) : null}
                  {importJob.errors.length > 0 ? (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => downloadErrorReport(importJob)}
                    >
                      <DownloadIcon data-icon="inline-start" aria-hidden="true" /> Baixar relatório
                      de erros
                    </Button>
                  ) : null}
                </div>
              </section>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileDownIcon aria-hidden="true" /> Exportar dados
            </CardTitle>
            <CardDescription>
              Escolha o domínio, o período e o formato. O download revalida sua permissão no momento
              da entrega.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="export-domain">Domínio</FieldLabel>
                <select
                  id="export-domain"
                  className="min-h-11 rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                  value={exportDomain}
                  disabled={!exportAllowed}
                  onChange={(event) => {
                    const next = event.target.value as DataDomain;
                    setExportDomain(next);
                    if (next !== "complete") setExportFormat("csv");
                    exportOperation.current.key = null;
                  }}
                >
                  <option value="transactions">Transações</option>
                  <option value="products">Produtos e estoque</option>
                  <option value="complete" disabled={!completeExportAllowed}>
                    Exportação completa (somente proprietário)
                  </option>
                </select>
              </Field>
              <Field>
                <FieldLabel htmlFor="export-format">Formato</FieldLabel>
                <select
                  id="export-format"
                  className="min-h-11 rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                  value={exportFormat}
                  disabled={!exportAllowed || exportDomain !== "complete"}
                  onChange={(event) => {
                    setExportFormat(event.target.value as "csv" | "zip");
                    exportOperation.current.key = null;
                  }}
                >
                  <option value="csv">CSV UTF-8</option>
                  <option value="zip">ZIP completo com manifesto</option>
                </select>
                <FieldDescription>
                  CSV é reimportável por domínio. ZIP reúne os domínios e o manifesto do schema.
                </FieldDescription>
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="export-from">De (opcional)</FieldLabel>
                  <Input
                    id="export-from"
                    type="date"
                    value={exportFrom}
                    disabled={!exportAllowed}
                    onChange={(event) => {
                      setExportFrom(event.target.value);
                      exportOperation.current.key = null;
                    }}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="export-to">Até (opcional)</FieldLabel>
                  <Input
                    id="export-to"
                    type="date"
                    value={exportTo}
                    disabled={!exportAllowed}
                    onChange={(event) => {
                      setExportTo(event.target.value);
                      exportOperation.current.key = null;
                    }}
                  />
                </Field>
              </div>
              {searchParams.has("from") ||
              searchParams.has("to") ||
              searchParams.has("kind") ||
              searchParams.has("categoryId") ? (
                <Alert>
                  <FileSpreadsheetIcon aria-hidden="true" />
                  <AlertDescription>
                    Este recorte veio de Relatórios: período {exportFrom || "aberto"} a{" "}
                    {exportTo || "aberto"}, tipo{" "}
                    {exportKind === "all" ? "receitas e despesas" : exportKind}, categoria{" "}
                    {exportCategoryId ?? "todas"}.
                  </AlertDescription>
                </Alert>
              ) : null}
            </FieldGroup>
            <Button
              type="button"
              className="min-h-11 w-full"
              disabled={
                !exportAllowed ||
                (exportDomain === "complete" && !completeExportAllowed) ||
                !online ||
                exportPending ||
                Boolean(activeExport && !terminalExport(activeExport))
              }
              onClick={() => void createExport()}
            >
              {exportPending || (activeExport && !terminalExport(activeExport)) ? (
                <LoaderCircleIcon
                  data-icon="inline-start"
                  className="animate-spin"
                  aria-hidden="true"
                />
              ) : (
                <FileDownIcon data-icon="inline-start" aria-hidden="true" />
              )}{" "}
              {exportPending ? "Gerando exportação…" : "Gerar exportação"}
            </Button>
            {activeExport && !terminalExport(activeExport) ? (
              <ProgressBar value={activeExport.progress} label="Gerando arquivo" />
            ) : null}
            {activeExport?.status === "completed" ? (
              <Alert>
                <CheckCircle2Icon aria-hidden="true" />
                <AlertTitle>Exportação pronta</AlertTitle>
                <AlertDescription className="flex flex-wrap items-center gap-3">
                  <span>{activeExport.fileName} · expira em 24 horas.</span>
                  <Button type="button" size="sm" onClick={() => void downloadExport(activeExport)}>
                    <DownloadIcon data-icon="inline-start" aria-hidden="true" /> Baixar arquivo
                  </Button>
                </AlertDescription>
              </Alert>
            ) : null}
            {exportError ? (
              <Alert variant="destructive">
                <AlertCircleIcon aria-hidden="true" />
                <AlertDescription>{exportError}</AlertDescription>
              </Alert>
            ) : null}
          </CardContent>
          <CardFooter className="text-xs text-muted-foreground">
            Acesso a exportação completa é exclusivo do proprietário e nunca usa URL bearer
            permanente.
          </CardFooter>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Exportações recentes</CardTitle>
          <CardDescription>
            Arquivos expiram automaticamente. Se sua permissão mudar, o download é bloqueado.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {exportSurfaceStatus === "loading" ? (
            <AsyncState status="loading" />
          ) : exportSurfaceStatus === "permission" ? (
            <AsyncState
              status="permission"
              title="Sem permissão para ver exportações"
              description={exportError ?? "Seu papel atual não permite consultar este histórico."}
              action={{ label: "Tentar novamente", onClick: () => void loadExports() }}
            />
          ) : exportSurfaceStatus === "error" || exportSurfaceStatus === "offline" ? (
            <AsyncState
              status={exportSurfaceStatus}
              description={exportError ?? undefined}
              action={{ label: "Tentar novamente", onClick: () => void loadExports() }}
            />
          ) : exportSurfaceStatus === "empty" ? (
            <Empty className="min-h-32 border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FileDownIcon aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>Nenhuma exportação ainda</EmptyTitle>
                <EmptyDescription>
                  Quando você gerar um arquivo, ele aparecerá aqui.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="flex flex-col divide-y">
              {exportJobs.slice(0, 5).map((job) => (
                <div
                  key={job.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-3"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <FileSpreadsheetIcon aria-hidden="true" />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {job.fileName ?? domainLabels[job.domain]}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {domainLabels[job.domain]} · {exportStatusLabel(job.status)}
                      </p>
                    </div>
                  </div>
                  {job.status === "completed" ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void downloadExport(job)}
                    >
                      <DownloadIcon data-icon="inline-start" aria-hidden="true" /> Baixar
                    </Button>
                  ) : (
                    <Badge variant="outline">{job.progress}%</Badge>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
