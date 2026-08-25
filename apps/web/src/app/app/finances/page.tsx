"use client";

import {
  ArchiveIcon,
  CalendarClockIcon,
  CheckIcon,
  CreditCardIcon,
  ListTreeIcon,
  LoaderCircleIcon,
  PencilIcon,
  PlusIcon,
  ReceiptTextIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { MoneyInput } from "@/components/primitives";
import { useAuthenticatedWorkspace } from "@/components/shell/app-shell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  type Category,
  type CreditCard,
  canWriteFinance,
  civilDateInTimeZone,
  clearTransactionQueryParams,
  commitmentBucket,
  commitmentRemainingMinor,
  createQuickCaptureTransactionInput,
  createRequestGuard,
  createWorkspaceGenerationGuard,
  type FinanceAdapter,
  FinanceAdapterError,
  type FinanceAuditEvent,
  financeAdapterForEnvironment,
  hasTransactionQueryFilters,
  listAllTransactions,
  mergeTransactionPage,
  previewInstallmentDates,
  previewInstallmentMinor,
  type SettlementInput,
  type Statement,
  type StatementItem,
  shouldRetryIdempotentCommand,
  statementItemAmountPrefix,
  type Transaction,
  transactionAmountPrefix,
  transactionKindLabel,
  transactionQueryFromSearchParams,
  type UpdateCreditCardInput,
  type Wallet,
  type WalletAdjustmentPreview,
} from "@/lib/finance";
import { formatMoneyMinor } from "@/lib/money";
import type { WorkspaceRole } from "@/lib/workspaces";

function transactionLabel(transaction: Transaction): string {
  if (transaction.description.trim()) return transaction.description;
  if (transaction.kind === "income") return "Receita sem descrição";
  if (transaction.kind === "expense") return "Despesa sem descrição";
  return transaction.kind === "transfer" ? "Transferência sem descrição" : "Ajuste sem descrição";
}

function statementLabel(statement: Statement): string {
  if (statement.state === "open") return "Aberta";
  if (statement.state === "closed") return "Fechada";
  if (statement.state === "paid") return "Paga";
  if (statement.state === "partially_paid") return "Parcialmente paga";
  return "Cancelada";
}

function auditActionLabel(action: string): string {
  if (action === "transaction.created") return "Lançamento criado";
  if (action === "transaction.posted") return "Lançamento realizado";
  if (action === "transaction.reversed") return "Lançamento desfeito";
  return action;
}

function auditSnapshotText(snapshot: Record<string, unknown> | null): string {
  if (!snapshot) return "Nenhum snapshot";
  return JSON.stringify(snapshot, null, 2) ?? "Nenhum snapshot";
}

type FinanceDashboardProps = {
  adapter?: FinanceAdapter;
  fixtureMode?: boolean;
  workspaceId: string;
  role: WorkspaceRole;
  timeZone: string;
  currency: string;
};

function FinanceDashboard({
  adapter: providedAdapter,
  fixtureMode = false,
  workspaceId,
  role,
  timeZone,
  currency,
}: FinanceDashboardProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [adapter] = useState<FinanceAdapter>(
    () => providedAdapter ?? financeAdapterForEnvironment({ fixtures: fixtureMode }),
  );
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [walletTransactions, setWalletTransactions] = useState<Transaction[]>([]);
  const [commitmentTransactions, setCommitmentTransactions] = useState<Transaction[]>([]);
  const [dataWorkspaceId, setDataWorkspaceId] = useState(workspaceId);
  const [transactionsNextCursor, setTransactionsNextCursor] = useState<string | null>(null);
  const [transactionsHasMore, setTransactionsHasMore] = useState(false);
  const [viewingTransaction, setViewingTransaction] = useState<Transaction | null>(null);
  const [transactionAudit, setTransactionAudit] = useState<FinanceAuditEvent[]>([]);
  const [transactionAuditNextCursor, setTransactionAuditNextCursor] = useState<string | null>(null);
  const [transactionAuditHasMore, setTransactionAuditHasMore] = useState(false);
  const [loadingTransactionAudit, setLoadingTransactionAudit] = useState(false);
  const [loadingMoreTransactionAudit, setLoadingMoreTransactionAudit] = useState(false);
  const [transactionAuditError, setTransactionAuditError] = useState<string | null>(null);
  const [selectedAuditId, setSelectedAuditId] = useState<string | null>(null);
  const [selectedAudit, setSelectedAudit] = useState<Awaited<
    ReturnType<FinanceAdapter["getTransactionAudit"]>
  > | null>(null);
  const [loadingAuditDetail, setLoadingAuditDetail] = useState(false);
  const [cards, setCards] = useState<CreditCard[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [statements, setStatements] = useState<Statement[]>([]);
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [transactionType, setTransactionType] = useState<"expense" | "income">("expense");
  const [transactionCardId, setTransactionCardId] = useState("");
  const [transactionCategoryId, setTransactionCategoryId] = useState("");
  const [amount, setAmount] = useState("0");
  const [description, setDescription] = useState("");
  const [planned, setPlanned] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showCardForm, setShowCardForm] = useState(false);
  const [cardName, setCardName] = useState("");
  const [closingDay, setClosingDay] = useState("10");
  const [dueDay, setDueDay] = useState("17");
  const [savingCard, setSavingCard] = useState(false);
  const [categoryName, setCategoryName] = useState("");
  const [categoryKind, setCategoryKind] = useState<Category["kind"]>("expense");
  const [editingCategory, setEditingCategory] = useState<Category | null>(null);
  const [savingCategory, setSavingCategory] = useState(false);
  const [editingCard, setEditingCard] = useState<CreditCard | null>(null);
  const [cardEditName, setCardEditName] = useState("");
  const [cardEditClosingDay, setCardEditClosingDay] = useState("10");
  const [cardEditDueDay, setCardEditDueDay] = useState("17");
  const [cardEditHolder, setCardEditHolder] = useState("");
  const [cardEditLastFour, setCardEditLastFour] = useState("");
  const [cardEditLimit, setCardEditLimit] = useState("");
  const [savingCardEdit, setSavingCardEdit] = useState(false);
  const [pendingCardArchive, setPendingCardArchive] = useState<CreditCard | null>(null);
  const [archivingCardId, setArchivingCardId] = useState<string | null>(null);
  const [busyStatementId, setBusyStatementId] = useState<string | null>(null);
  const [viewingStatement, setViewingStatement] = useState<Statement | null>(null);
  const [statementItems, setStatementItems] = useState<StatementItem[]>([]);
  const [statementItemsNextCursor, setStatementItemsNextCursor] = useState<string | null>(null);
  const [statementItemsHasMore, setStatementItemsHasMore] = useState(false);
  const [loadingStatementItems, setLoadingStatementItems] = useState(false);
  const [loadingMoreStatementItems, setLoadingMoreStatementItems] = useState(false);
  const [pendingStatementAction, setPendingStatementAction] = useState<{
    type: "close" | "reopen";
    statement: Statement;
  } | null>(null);
  const [statementItemsRequest] = useState(createRequestGuard);
  const [transactionAuditRequest] = useState(createRequestGuard);
  const [transactionAuditDetailRequest] = useState(createRequestGuard);
  const [timelineRequest] = useState(createRequestGuard);
  const [transactionDeepLinkRequest] = useState(createRequestGuard);
  const [statementDeepLinkRequest] = useState(createRequestGuard);
  const [workspaceRequests] = useState(() => createWorkspaceGenerationGuard(workspaceId));
  const [timelineSearch, setTimelineSearch] = useState("");
  const [timelineFrom, setTimelineFrom] = useState("");
  const [timelineTo, setTimelineTo] = useState("");
  const [timelineState, setTimelineState] = useState<"" | Transaction["state"]>("");
  const [timelineKind, setTimelineKind] = useState<"" | Transaction["kind"]>("");
  const [undoableTransaction, setUndoableTransaction] = useState<Transaction | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [settlingTransaction, setSettlingTransaction] = useState<Transaction | null>(null);
  const [settlementAmount, setSettlementAmount] = useState("");
  const [settlementDate, setSettlementDate] = useState("");
  const [settling, setSettling] = useState(false);
  const [showRecurrenceForm, setShowRecurrenceForm] = useState(false);
  const [recurrenceKind, setRecurrenceKind] = useState<"expense" | "income">("expense");
  const [recurrenceAmount, setRecurrenceAmount] = useState("0");
  const [recurrenceEstimatedAmount, setRecurrenceEstimatedAmount] = useState("0");
  const [recurrenceVariable, setRecurrenceVariable] = useState(false);
  const [recurrenceFrequency, setRecurrenceFrequency] = useState<"weekly" | "monthly" | "annual">(
    "monthly",
  );
  const [recurrenceInterval, setRecurrenceInterval] = useState("1");
  const [recurrenceStartOn, setRecurrenceStartOn] = useState("");
  const [recurrenceEndOn, setRecurrenceEndOn] = useState("");
  const [recurrenceDescription, setRecurrenceDescription] = useState("");
  const [savingRecurrence, setSavingRecurrence] = useState(false);
  const [showInstallmentForm, setShowInstallmentForm] = useState(false);
  const [installmentTotal, setInstallmentTotal] = useState("0");
  const [installmentCount, setInstallmentCount] = useState("2");
  const [installmentFirstDueOn, setInstallmentFirstDueOn] = useState("");
  const [installmentDescription, setInstallmentDescription] = useState("");
  const [savingInstallment, setSavingInstallment] = useState(false);
  const [pendingStatementPayment, setPendingStatementPayment] = useState<Statement | null>(null);
  const [statementPaymentAmount, setStatementPaymentAmount] = useState("");
  const [payingStatement, setPayingStatement] = useState(false);
  const [walletAdjustmentOpen, setWalletAdjustmentOpen] = useState(false);
  const [observedWalletBalance, setObservedWalletBalance] = useState("0");
  const [walletAdjustmentReason, setWalletAdjustmentReason] = useState("");
  const [walletAdjustmentPreview, setWalletAdjustmentPreview] =
    useState<WalletAdjustmentPreview | null>(null);
  const [walletAdjustmentError, setWalletAdjustmentError] = useState<string | null>(null);
  const [previewingWalletAdjustment, setPreviewingWalletAdjustment] = useState(false);
  const [savingWalletAdjustment, setSavingWalletAdjustment] = useState(false);
  const [walletAdjustmentConfirmed, setWalletAdjustmentConfirmed] = useState(false);
  const transactionCommandKey = useRef<string | null>(null);
  const transactionReverseCommandKey = useRef<string | null>(null);
  const settlementCommandKey = useRef<string | null>(null);
  const statementPaymentCommandKey = useRef<string | null>(null);
  const recurrenceCommandKey = useRef<string | null>(null);
  const installmentCommandKey = useRef<string | null>(null);
  const walletAdjustmentCommandKey = useRef<string | null>(null);
  const transactionCommandWorkspace = useRef(workspaceId);
  const writeAccess = canWriteFinance(role);
  const today = civilDateInTimeZone(new Date(), timeZone);

  const commitments = useMemo(
    () =>
      commitmentTransactions
        .map((transaction) => ({
          transaction,
          bucket: commitmentBucket(transaction, today),
        }))
        .filter(
          (item): item is { transaction: Transaction; bucket: "upcoming" | "overdue" } =>
            item.bucket !== null,
        )
        .sort((left, right) => {
          const leftDate = left.transaction.dueOn ?? "9999-12-31";
          const rightDate = right.transaction.dueOn ?? "9999-12-31";
          return (
            leftDate.localeCompare(rightDate) ||
            left.transaction.id.localeCompare(right.transaction.id)
          );
        }),
    [commitmentTransactions, today],
  );
  const overdueCommitments = commitments.filter((item) => item.bucket === "overdue");
  const upcomingCommitments = commitments.filter((item) => item.bucket === "upcoming");

  const timelineQuery = useMemo(
    () => transactionQueryFromSearchParams(new URLSearchParams(searchParams.toString())),
    [searchParams],
  );

  const hasTimelineFilters = hasTransactionQueryFilters(timelineQuery);

  useEffect(() => {
    setTimelineSearch(timelineQuery.search ?? "");
    setTimelineFrom(timelineQuery.from ?? "");
    setTimelineTo(timelineQuery.to ?? "");
    setTimelineState(timelineQuery.state ?? "");
    setTimelineKind(timelineQuery.kind ?? "");
  }, [timelineQuery]);

  useEffect(() => {
    if (!undoableTransaction) return;
    const timeout = window.setTimeout(() => setUndoableTransaction(null), 10_000);
    return () => window.clearTimeout(timeout);
  }, [undoableTransaction]);

  useEffect(() => {
    workspaceRequests.switchWorkspace(workspaceId);
    timelineRequest.invalidate();
    transactionDeepLinkRequest.invalidate();
    statementDeepLinkRequest.invalidate();
    statementItemsRequest.invalidate();
    transactionAuditRequest.invalidate();
    transactionAuditDetailRequest.invalidate();
    // Clear every workspace-scoped value before the next workspace can render. The
    // generation guard prevents late responses from repopulating this empty state.
    setDataWorkspaceId(workspaceId);
    setTransactions([]);
    setWallet(null);
    setWalletTransactions([]);
    setCommitmentTransactions([]);
    setTransactionsNextCursor(null);
    setTransactionsHasMore(false);
    setCards([]);
    setCategories([]);
    setStatements([]);
    setStatus("loading");
    setError(null);
    setNotice(null);
    setViewingTransaction(null);
    setTransactionAudit([]);
    setTransactionAuditNextCursor(null);
    setTransactionAuditHasMore(false);
    setLoadingTransactionAudit(false);
    setLoadingMoreTransactionAudit(false);
    setTransactionAuditError(null);
    setSelectedAuditId(null);
    setSelectedAudit(null);
    setLoadingAuditDetail(false);
    setViewingStatement(null);
    setStatementItems([]);
    setStatementItemsNextCursor(null);
    setStatementItemsHasMore(false);
    setLoadingStatementItems(false);
    setLoadingMoreStatementItems(false);
    transactionCommandKey.current = null;
    transactionReverseCommandKey.current = null;
    statementPaymentCommandKey.current = null;
    recurrenceCommandKey.current = null;
    installmentCommandKey.current = null;
    setSaving(false);
    setUndoing(false);
    setSavingCard(false);
    setSavingCategory(false);
    setCategoryName("");
    setCategoryKind("expense");
    setEditingCategory(null);
    setEditingCard(null);
    setSavingCardEdit(false);
    setPendingCardArchive(null);
    setArchivingCardId(null);
    setBusyStatementId(null);
    setPendingStatementAction(null);
    setUndoableTransaction(null);
    setSettlingTransaction(null);
    setSettlementAmount("");
    setSettlementDate("");
    setShowRecurrenceForm(false);
    setShowInstallmentForm(false);
    setPendingStatementPayment(null);
    setStatementPaymentAmount("");
    setWalletAdjustmentOpen(false);
    setObservedWalletBalance("0");
    setWalletAdjustmentReason("");
    setWalletAdjustmentPreview(null);
    setWalletAdjustmentError(null);
    setPreviewingWalletAdjustment(false);
    setSavingWalletAdjustment(false);
    setWalletAdjustmentConfirmed(false);
    walletAdjustmentCommandKey.current = null;
    setSettling(false);
    setSavingRecurrence(false);
    setSavingInstallment(false);
    settlementCommandKey.current = null;
  }, [
    statementDeepLinkRequest,
    statementItemsRequest,
    transactionDeepLinkRequest,
    timelineRequest,
    transactionAuditDetailRequest,
    transactionAuditRequest,
    workspaceId,
    workspaceRequests,
  ]);

  // Effects run after a render. Until the switch effect above has cleared the
  // old snapshot, keep it out of the new workspace's visible tree.
  const workspaceDataReady = dataWorkspaceId === workspaceId;
  const visibleTransactions = workspaceDataReady ? transactions : [];
  const visibleWallet = workspaceDataReady ? wallet : null;
  const visibleCards = workspaceDataReady ? cards : [];
  const visibleCategories = workspaceDataReady ? categories : [];
  const visibleStatements = workspaceDataReady ? statements : [];
  const visibleError = workspaceDataReady ? error : null;
  const visibleNotice = workspaceDataReady ? notice : null;
  const visibleStatus = workspaceDataReady ? status : "loading";
  const visibleViewingTransaction = workspaceDataReady ? viewingTransaction : null;
  const visibleTransactionAudit = workspaceDataReady ? transactionAudit : [];
  const visibleTransactionAuditError = workspaceDataReady ? transactionAuditError : null;
  const visibleSelectedAudit = workspaceDataReady ? selectedAudit : null;
  const walletAdjustmentDifferenceMinor = walletAdjustmentPreview
    ? BigInt(walletAdjustmentPreview.difference.minor)
    : null;
  const walletAdjustmentAbsoluteDifference =
    walletAdjustmentDifferenceMinor === null
      ? null
      : walletAdjustmentDifferenceMinor < BigInt(0)
        ? -walletAdjustmentDifferenceMinor
        : walletAdjustmentDifferenceMinor;
  const visibleViewingStatement = workspaceDataReady ? viewingStatement : null;
  const visiblePendingStatementAction = workspaceDataReady ? pendingStatementAction : null;
  const visibleEditingCard = workspaceDataReady ? editingCard : null;
  const visiblePendingCardArchive = workspaceDataReady ? pendingCardArchive : null;

  const transactionTargetId = searchParams.get("transaction");
  const statementTargetId = searchParams.get("statement");

  useEffect(() => {
    if (!workspaceDataReady || !transactionTargetId) return;
    const target = [...walletTransactions, ...transactions].find(
      (transaction) => transaction.id === transactionTargetId,
    );
    const request = transactionDeepLinkRequest.begin();
    if (target) {
      setViewingTransaction(target);
      return () => transactionDeepLinkRequest.invalidate();
    }
    void adapter
      .getTransaction(workspaceId, transactionTargetId)
      .then((resolved) => {
        if (transactionDeepLinkRequest.isCurrent(request) && workspaceDataReady) {
          setViewingTransaction(resolved);
        }
      })
      .catch((cause: unknown) => {
        if (!transactionDeepLinkRequest.isCurrent(request) || !workspaceDataReady) return;
        setViewingTransaction(null);
        if (cause instanceof FinanceAdapterError && cause.status === 404) return;
        setError(cause instanceof Error ? cause.message : "Não foi possível abrir o lançamento.");
      });
    return () => transactionDeepLinkRequest.invalidate();
  }, [
    adapter,
    transactionDeepLinkRequest,
    transactionTargetId,
    transactions,
    walletTransactions,
    workspaceDataReady,
    workspaceId,
  ]);

  useEffect(() => {
    if (!workspaceDataReady || !statementTargetId) return;
    const target = statements.find((statement) => statement.id === statementTargetId);
    const request = statementDeepLinkRequest.begin();
    if (target) {
      setViewingStatement(target);
      return () => statementDeepLinkRequest.invalidate();
    }
    void adapter
      .getStatement(workspaceId, statementTargetId)
      .then((resolved) => {
        if (statementDeepLinkRequest.isCurrent(request) && workspaceDataReady) {
          setViewingStatement(resolved);
        }
      })
      .catch((cause: unknown) => {
        if (!statementDeepLinkRequest.isCurrent(request) || !workspaceDataReady) return;
        setViewingStatement(null);
        if (cause instanceof FinanceAdapterError && cause.status === 404) return;
        setError(cause instanceof Error ? cause.message : "Não foi possível abrir a fatura.");
      });
    return () => statementDeepLinkRequest.invalidate();
  }, [
    adapter,
    statementDeepLinkRequest,
    statementTargetId,
    statements,
    workspaceDataReady,
    workspaceId,
  ]);

  useEffect(() => {
    if (transactionCommandWorkspace.current === workspaceId) return;
    transactionCommandWorkspace.current = workspaceId;
    transactionCommandKey.current = null;
  }, [workspaceId]);

  function updateTimelineQuery(values: {
    search?: string;
    from?: string;
    to?: string;
    state?: string;
    kind?: string;
    cursor?: string | null;
  }) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(values)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    if (!("cursor" in values)) params.delete("cursor");
    const query = params.toString();
    router.replace(`/app/finances${query ? `?${query}` : ""}`, { scroll: false });
  }

  function clearDeepLinkParam(param: "transaction" | "statement") {
    if (!searchParams.has(param)) return;
    const params = new URLSearchParams(searchParams.toString());
    params.delete(param);
    const query = params.toString();
    router.replace(`/app/finances${query ? `?${query}` : ""}`, { scroll: false });
  }

  const load = useCallback(
    async (append = false) => {
      const request = timelineRequest.begin();
      const workspaceRequest = workspaceRequests.begin(workspaceId);
      setStatus("loading");
      setError(null);
      setViewingStatement(null);
      setStatementItems([]);
      setStatementItemsNextCursor(null);
      setStatementItemsHasMore(false);
      try {
        const [
          nextTransactions,
          nextWallet,
          nextCards,
          nextStatements,
          nextCategories,
          nextWalletTransactions,
        ] = await Promise.all([
          adapter.listTransactions(workspaceId, { ...timelineQuery, limit: 50 }),
          adapter.getWallet(workspaceId),
          adapter.listCards(workspaceId),
          adapter.listStatements(workspaceId),
          adapter.listCategories(workspaceId),
          listAllTransactions(adapter, workspaceId),
        ]);
        if (!timelineRequest.isCurrent(request) || !workspaceRequests.isCurrent(workspaceRequest))
          return;
        setTransactions((current) => mergeTransactionPage(current, nextTransactions, append));
        setWallet(nextWallet);
        setTransactionsNextCursor(nextTransactions.nextCursor);
        setTransactionsHasMore(nextTransactions.hasMore);
        setWalletTransactions(nextWalletTransactions);
        const commitmentById = new Map(
          nextWalletTransactions
            .filter(
              (transaction) =>
                transaction.state === "planned" || transaction.state === "partially_settled",
            )
            .map((transaction) => [transaction.id, transaction]),
        );
        setCommitmentTransactions([...commitmentById.values()]);
        setCards(nextCards);
        setStatements(nextStatements);
        setCategories(nextCategories);
        setStatus("success");
      } catch (cause) {
        if (!timelineRequest.isCurrent(request) || !workspaceRequests.isCurrent(workspaceRequest))
          return;
        setStatus("error");
        setError(
          cause instanceof Error ? cause.message : "Não foi possível carregar suas finanças.",
        );
      }
    },
    [adapter, timelineQuery, timelineRequest, workspaceId, workspaceRequests],
  );

  useEffect(() => {
    void load(Boolean(timelineQuery.cursor));
  }, [load, timelineQuery.cursor]);

  async function handleTransactionSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || BigInt(amount || "0") <= BigInt(0)) {
      setError("Informe um valor maior que zero.");
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    const workspaceRequest = workspaceRequests.begin(workspaceId);
    const commandKey = transactionCommandKey.current ?? `web-${crypto.randomUUID()}`;
    transactionCommandKey.current = commandKey;
    try {
      const created = await adapter.createTransaction(
        workspaceId,
        createQuickCaptureTransactionInput({
          kind: transactionType,
          amountMinor: amount,
          currency,
          planned,
          description,
          cardId: transactionCardId,
          categoryId: transactionCategoryId,
        }),
        commandKey,
      );
      if (!workspaceRequests.isCurrent(workspaceRequest)) return;
      transactionCommandKey.current = null;
      setAmount("0");
      setDescription("");
      setTransactionCardId("");
      setTransactionCategoryId("");
      setPlanned(false);
      if (timelineQuery.cursor) updateTimelineQuery({ cursor: null });
      else await load(false);
      if (!workspaceRequests.isCurrent(workspaceRequest)) return;
      setNotice(planned ? "Compromisso salvo." : "Lançamento salvo.");
      setUndoableTransaction(planned ? null : created);
    } catch (cause) {
      if (!workspaceRequests.isCurrent(workspaceRequest)) return;
      if (!shouldRetryIdempotentCommand(cause)) transactionCommandKey.current = null;
      setError(cause instanceof Error ? cause.message : "Não foi possível salvar o lançamento.");
    } finally {
      if (workspaceRequests.isCurrent(workspaceRequest)) setSaving(false);
    }
  }

  function openSettlement(transaction: Transaction) {
    setSettlingTransaction(transaction);
    setSettlementAmount(commitmentRemainingMinor(transaction));
    setSettlementDate(today);
    setSettlementError(null);
  }

  const [settlementError, setSettlementError] = useState<string | null>(null);

  async function handleSettlementSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!settlingTransaction || settling || !writeAccess) return;
    let effectiveMinor: bigint;
    try {
      effectiveMinor = BigInt(settlementAmount);
    } catch {
      setSettlementError("Informe um valor válido para esta liquidação.");
      return;
    }
    const remainingMinor = BigInt(commitmentRemainingMinor(settlingTransaction));
    if (effectiveMinor <= BigInt(0) || effectiveMinor > remainingMinor) {
      setSettlementError("O valor deve ser maior que zero e não pode superar o saldo restante.");
      return;
    }
    const input: SettlementInput = {
      amount: { currency, minor: effectiveMinor.toString() },
      ...(settlementDate ? { occurredOn: settlementDate } : {}),
    };
    setSettling(true);
    setSettlementError(null);
    setError(null);
    const workspaceRequest = workspaceRequests.begin(workspaceId);
    const commandKey = settlementCommandKey.current ?? `web-settle-${crypto.randomUUID()}`;
    settlementCommandKey.current = commandKey;
    try {
      const updated = await adapter.postTransaction(
        workspaceId,
        settlingTransaction,
        input,
        commandKey,
      );
      if (!workspaceRequests.isCurrent(workspaceRequest)) return;
      settlementCommandKey.current = null;
      setTransactions((current) =>
        current.map((transaction) => (transaction.id === updated.id ? updated : transaction)),
      );
      setWalletTransactions((current) => [
        ...current.filter((transaction) => transaction.id !== updated.id),
        updated,
      ]);
      setCommitmentTransactions((current) =>
        updated.state === "posted" || updated.state === "canceled"
          ? current.filter((transaction) => transaction.id !== updated.id)
          : current.map((transaction) => (transaction.id === updated.id ? updated : transaction)),
      );
      setSettlingTransaction(null);
      setNotice(
        updated.state === "posted" ? "Compromisso liquidado." : "Liquidação parcial registrada.",
      );
    } catch (cause) {
      if (!workspaceRequests.isCurrent(workspaceRequest)) return;
      if (cause instanceof FinanceAdapterError && cause.status === 412) {
        settlementCommandKey.current = null;
        setSettlingTransaction(null);
        await load();
        if (workspaceRequests.isCurrent(workspaceRequest)) {
          setNotice("O compromisso mudou enquanto você o revisava. Recarregamos os dados.");
        }
      } else {
        if (!shouldRetryIdempotentCommand(cause)) settlementCommandKey.current = null;
        setSettlementError(
          cause instanceof Error ? cause.message : "Não foi possível liquidar o compromisso.",
        );
      }
    } finally {
      if (workspaceRequests.isCurrent(workspaceRequest)) setSettling(false);
    }
  }

  async function handleRecurrenceSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (savingRecurrence || !writeAccess) return;
    let recurrenceAmountMinor: bigint;
    let estimatedAmountMinor: bigint;
    try {
      recurrenceAmountMinor = BigInt(recurrenceAmount || "0");
      estimatedAmountMinor = BigInt(recurrenceEstimatedAmount || "0");
    } catch {
      setError("Informe valores monetários válidos para a recorrência.");
      return;
    }
    if (recurrenceAmountMinor <= BigInt(0)) {
      setError("Informe o valor planejado da recorrência.");
      return;
    }
    if (recurrenceVariable && estimatedAmountMinor < BigInt(0)) {
      setError("A estimativa da recorrência não pode ser negativa.");
      return;
    }
    setSavingRecurrence(true);
    setError(null);
    const workspaceRequest = workspaceRequests.begin(workspaceId);
    const commandKey = recurrenceCommandKey.current ?? `web-recurrence-${crypto.randomUUID()}`;
    recurrenceCommandKey.current = commandKey;
    try {
      const result = await adapter.createRecurrence(
        workspaceId,
        {
          kind: recurrenceKind,
          amount: { currency, minor: recurrenceAmount },
          frequency: recurrenceFrequency,
          interval: Number(recurrenceInterval),
          startOn: recurrenceStartOn || today,
          endOn: recurrenceEndOn || null,
          maxOccurrences: null,
          variable: recurrenceVariable,
          estimatedAmount:
            recurrenceVariable && estimatedAmountMinor > BigInt(0)
              ? { currency, minor: recurrenceEstimatedAmount }
              : null,
          description: recurrenceDescription.trim(),
        },
        commandKey,
      );
      if (!workspaceRequests.isCurrent(workspaceRequest)) return;
      recurrenceCommandKey.current = null;
      setShowRecurrenceForm(false);
      setNotice(`Recorrência criada com ${result.occurrences.length} ocorrência(s) inicial(is).`);
      setRecurrenceAmount("0");
      setRecurrenceEstimatedAmount("0");
      setRecurrenceDescription("");
      await load();
    } catch (cause) {
      if (workspaceRequests.isCurrent(workspaceRequest)) {
        if (!shouldRetryIdempotentCommand(cause)) recurrenceCommandKey.current = null;
        setError(cause instanceof Error ? cause.message : "Não foi possível criar a recorrência.");
      }
    } finally {
      if (workspaceRequests.isCurrent(workspaceRequest)) setSavingRecurrence(false);
    }
  }

  async function handleInstallmentSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (savingInstallment || !writeAccess) return;
    const count = Number(installmentCount);
    if (previewInstallmentMinor(installmentTotal, count).length === 0) {
      setError("Informe um total positivo e entre 2 e 999 parcelas.");
      return;
    }
    setSavingInstallment(true);
    setError(null);
    const workspaceRequest = workspaceRequests.begin(workspaceId);
    const commandKey = installmentCommandKey.current ?? `web-installment-${crypto.randomUUID()}`;
    installmentCommandKey.current = commandKey;
    try {
      const result = await adapter.createInstallmentPlan(
        workspaceId,
        {
          total: { currency, minor: installmentTotal },
          count,
          firstDueOn: installmentFirstDueOn || today,
          description: installmentDescription.trim(),
        },
        commandKey,
      );
      if (!workspaceRequests.isCurrent(workspaceRequest)) return;
      installmentCommandKey.current = null;
      setShowInstallmentForm(false);
      setNotice(`Parcelamento criado com ${result.installments.length} parcela(s).`);
      setInstallmentTotal("0");
      setInstallmentDescription("");
      await load();
    } catch (cause) {
      if (workspaceRequests.isCurrent(workspaceRequest)) {
        if (!shouldRetryIdempotentCommand(cause)) installmentCommandKey.current = null;
        setError(cause instanceof Error ? cause.message : "Não foi possível criar o parcelamento.");
      }
    } finally {
      if (workspaceRequests.isCurrent(workspaceRequest)) setSavingInstallment(false);
    }
  }

  async function undoTransaction() {
    if (!undoableTransaction || undoing) return;
    setUndoing(true);
    setError(null);
    const workspaceRequest = workspaceRequests.begin(workspaceId);
    const commandKey = transactionReverseCommandKey.current ?? `web-reverse-${crypto.randomUUID()}`;
    transactionReverseCommandKey.current = commandKey;
    try {
      await adapter.reverseTransaction(workspaceId, undoableTransaction, commandKey);
      if (!workspaceRequests.isCurrent(workspaceRequest)) return;
      transactionReverseCommandKey.current = null;
      setUndoableTransaction(null);
      if (timelineQuery.cursor) updateTimelineQuery({ cursor: null });
      else await load(false);
      if (!workspaceRequests.isCurrent(workspaceRequest)) return;
      setNotice("Lançamento desfeito.");
    } catch (cause) {
      if (!workspaceRequests.isCurrent(workspaceRequest)) return;
      if (!shouldRetryIdempotentCommand(cause)) transactionReverseCommandKey.current = null;
      setError(cause instanceof Error ? cause.message : "Não foi possível desfazer o lançamento.");
    } finally {
      if (workspaceRequests.isCurrent(workspaceRequest)) setUndoing(false);
    }
  }

  function applyTimelineFilters(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    updateTimelineQuery({
      search: timelineSearch.trim(),
      from: timelineFrom,
      to: timelineTo,
      state: timelineState,
      kind: timelineKind,
    });
  }

  function clearTimelineFilters() {
    setTimelineSearch("");
    setTimelineFrom("");
    setTimelineTo("");
    setTimelineState("");
    setTimelineKind("");
    const params = clearTransactionQueryParams(new URLSearchParams(searchParams.toString()));
    const query = params.toString();
    router.replace(`/app/finances${query ? `?${query}` : ""}`, { scroll: false });
  }

  async function handleCardSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (savingCard || !cardName.trim()) return;
    setSavingCard(true);
    setError(null);
    const workspaceRequest = workspaceRequests.begin(workspaceId);
    try {
      const card = await adapter.createCard(workspaceId, {
        name: cardName.trim(),
        closingDay: Number(closingDay),
        dueDay: Number(dueDay),
      });
      if (!workspaceRequests.isCurrent(workspaceRequest)) return;
      setCards((current) => [...current, card]);
      setCardName("");
      setShowCardForm(false);
      setNotice("Cartão cadastrado.");
    } catch (cause) {
      if (!workspaceRequests.isCurrent(workspaceRequest)) return;
      setError(cause instanceof Error ? cause.message : "Não foi possível cadastrar o cartão.");
    } finally {
      if (workspaceRequests.isCurrent(workspaceRequest)) setSavingCard(false);
    }
  }

  async function handleCategorySubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = categoryName.trim();
    if (savingCategory || !name || !writeAccess) return;
    setSavingCategory(true);
    setError(null);
    const workspaceRequest = workspaceRequests.begin(workspaceId);
    try {
      const value = editingCategory
        ? await adapter.updateCategory(workspaceId, editingCategory, {
            name,
            kind: categoryKind,
          })
        : await adapter.createCategory(workspaceId, { name, kind: categoryKind });
      if (!workspaceRequests.isCurrent(workspaceRequest)) return;
      setCategories((current) => {
        const index = current.findIndex((category) => category.id === value.id);
        if (index < 0) return [...current, value];
        return current.map((category) => (category.id === value.id ? value : category));
      });
      setCategoryName("");
      setCategoryKind("expense");
      setEditingCategory(null);
      setNotice(editingCategory ? "Categoria atualizada." : "Categoria criada.");
    } catch (cause) {
      if (!workspaceRequests.isCurrent(workspaceRequest)) return;
      setError(cause instanceof Error ? cause.message : "Não foi possível salvar a categoria.");
    } finally {
      if (workspaceRequests.isCurrent(workspaceRequest)) setSavingCategory(false);
    }
  }

  async function transitionCategory(category: Category, action: "archive" | "restore") {
    if (savingCategory || !writeAccess) return;
    setSavingCategory(true);
    setError(null);
    const workspaceRequest = workspaceRequests.begin(workspaceId);
    try {
      const value =
        action === "archive"
          ? await adapter.archiveCategory(workspaceId, category)
          : await adapter.restoreCategory(workspaceId, category);
      if (!workspaceRequests.isCurrent(workspaceRequest)) return;
      setCategories((current) => current.map((item) => (item.id === value.id ? value : item)));
      setNotice(action === "archive" ? "Categoria arquivada." : "Categoria restaurada.");
    } catch (cause) {
      if (!workspaceRequests.isCurrent(workspaceRequest)) return;
      setError(
        cause instanceof Error
          ? cause.message
          : `Não foi possível ${action === "archive" ? "arquivar" : "restaurar"} a categoria.`,
      );
    } finally {
      if (workspaceRequests.isCurrent(workspaceRequest)) setSavingCategory(false);
    }
  }

  function openCardEditor(card: CreditCard) {
    setEditingCard(card);
    setCardEditName(card.name);
    setCardEditClosingDay(String(card.closingDay));
    setCardEditDueDay(String(card.dueDay));
    setCardEditHolder(card.holder ?? "");
    setCardEditLastFour(card.lastFour ?? "");
    setCardEditLimit(card.limit?.minor ?? "");
    setError(null);
  }

  async function handleCardEditSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingCard || savingCardEdit) return;
    const nextClosingDay = Number(cardEditClosingDay);
    const nextDueDay = Number(cardEditDueDay);
    if (!cardEditName.trim()) {
      setError("Informe um nome para o cartão.");
      return;
    }
    if (
      !Number.isInteger(nextClosingDay) ||
      nextClosingDay < 1 ||
      nextClosingDay > 31 ||
      !Number.isInteger(nextDueDay) ||
      nextDueDay < 1 ||
      nextDueDay > 31
    ) {
      setError("Fechamento e vencimento devem estar entre 1 e 31.");
      return;
    }
    const normalizedLastFour = cardEditLastFour.trim();
    if (normalizedLastFour && !/^\d{4}$/.test(normalizedLastFour)) {
      setError("Os últimos quatro dígitos devem conter somente quatro números.");
      return;
    }
    const input: UpdateCreditCardInput = {
      name: cardEditName.trim(),
      closingDay: nextClosingDay,
      dueDay: nextDueDay,
      holder: cardEditHolder.trim() || null,
      lastFour: normalizedLastFour || null,
      limit: cardEditLimit ? { currency, minor: cardEditLimit } : null,
    };
    setSavingCardEdit(true);
    setError(null);
    const workspaceRequest = workspaceRequests.begin(workspaceId);
    try {
      const updated = await adapter.updateCard(workspaceId, editingCard, input);
      if (!workspaceRequests.isCurrent(workspaceRequest)) return;
      setCards((current) => current.map((value) => (value.id === updated.id ? updated : value)));
      setEditingCard(null);
      setNotice("Configuração do cartão atualizada.");
    } catch (cause) {
      if (!workspaceRequests.isCurrent(workspaceRequest)) return;
      if (cause instanceof FinanceAdapterError && cause.status === 412) {
        setEditingCard(null);
        await load();
        if (!workspaceRequests.isCurrent(workspaceRequest)) return;
        setNotice(
          "O cartão mudou enquanto você o editava. Recarregamos os dados; revise antes de tentar novamente.",
        );
      } else {
        setError(cause instanceof Error ? cause.message : "Não foi possível atualizar o cartão.");
      }
    } finally {
      if (workspaceRequests.isCurrent(workspaceRequest)) setSavingCardEdit(false);
    }
  }

  async function handleCardArchive() {
    if (!pendingCardArchive || archivingCardId) return;
    const card = pendingCardArchive;
    setArchivingCardId(card.id);
    setError(null);
    const workspaceRequest = workspaceRequests.begin(workspaceId);
    try {
      const archived = await adapter.archiveCard(workspaceId, card);
      if (!workspaceRequests.isCurrent(workspaceRequest)) return;
      setCards((current) => current.map((value) => (value.id === archived.id ? archived : value)));
      setPendingCardArchive(null);
      setNotice("Cartão arquivado. O histórico de faturas foi preservado.");
    } catch (cause) {
      if (!workspaceRequests.isCurrent(workspaceRequest)) return;
      if (cause instanceof FinanceAdapterError && cause.status === 412) {
        setPendingCardArchive(null);
        await load();
        if (!workspaceRequests.isCurrent(workspaceRequest)) return;
        setNotice(
          "O cartão mudou enquanto você o revisava. Recarregamos os dados; revise antes de tentar novamente.",
        );
      } else {
        setError(cause instanceof Error ? cause.message : "Não foi possível arquivar o cartão.");
      }
    } finally {
      if (workspaceRequests.isCurrent(workspaceRequest)) setArchivingCardId(null);
    }
  }

  async function runStatementAction(type: "close" | "reopen", statement: Statement) {
    if (busyStatementId) return;
    setBusyStatementId(statement.id);
    setError(null);
    const workspaceRequest = workspaceRequests.begin(workspaceId);
    try {
      const updated =
        type === "close"
          ? await adapter.closeStatement(workspaceId, statement)
          : await adapter.reopenStatement(workspaceId, statement);
      if (!workspaceRequests.isCurrent(workspaceRequest)) return;
      setStatements((current) =>
        current.map((value) => (value.id === updated.id ? updated : value)),
      );
      setPendingStatementAction(null);
      setNotice(
        type === "close"
          ? "Fatura fechada. Compras novas entram no próximo ciclo."
          : "Fatura reaberta. Novos lançamentos podem voltar a compor este ciclo.",
      );
    } catch (cause) {
      if (cause instanceof FinanceAdapterError && cause.status === 412) {
        if (!workspaceRequests.isCurrent(workspaceRequest)) return;
        setPendingStatementAction(null);
        await load();
        if (!workspaceRequests.isCurrent(workspaceRequest)) return;
        setNotice(
          "A fatura mudou enquanto você revisava. Recarregamos os dados; revise antes de tentar novamente.",
        );
        return;
      }
      if (!workspaceRequests.isCurrent(workspaceRequest)) return;
      setError(
        cause instanceof Error
          ? cause.message
          : `Não foi possível ${type === "close" ? "fechar" : "reabrir"} a fatura.`,
      );
    } finally {
      if (workspaceRequests.isCurrent(workspaceRequest)) setBusyStatementId(null);
    }
  }

  const viewingStatementId = visibleViewingStatement?.id;

  const installmentPreview = useMemo(() => {
    const count = Number(installmentCount);
    const amounts = previewInstallmentMinor(installmentTotal, count);
    const dates = previewInstallmentDates(installmentFirstDueOn || today, count);
    return amounts.map((minor, index) => ({
      minor,
      number: index + 1,
      dueOn: dates[index] ?? (installmentFirstDueOn || today),
    }));
  }, [installmentCount, installmentFirstDueOn, installmentTotal, today]);

  const loadStatementItems = useCallback(
    async (statementId: string, cursor: string | undefined, append: boolean) => {
      const request = statementItemsRequest.begin();
      const workspaceRequest = workspaceRequests.begin(workspaceId);
      if (append) {
        setLoadingMoreStatementItems(true);
      } else {
        setStatementItems([]);
        setStatementItemsNextCursor(null);
        setStatementItemsHasMore(false);
        setLoadingStatementItems(true);
      }
      setError(null);
      try {
        const page = await adapter.listStatementItems(workspaceId, statementId, {
          cursor,
          limit: 50,
        });
        if (
          !statementItemsRequest.isCurrent(request) ||
          !workspaceRequests.isCurrent(workspaceRequest)
        )
          return;
        setStatementItems((current) => (append ? [...current, ...page.items] : page.items));
        setStatementItemsNextCursor(page.nextCursor);
        setStatementItemsHasMore(page.hasMore);
      } catch (cause) {
        if (
          !statementItemsRequest.isCurrent(request) ||
          !workspaceRequests.isCurrent(workspaceRequest)
        )
          return;
        setError(
          cause instanceof Error ? cause.message : "Não foi possível carregar a composição.",
        );
        if (!append) setViewingStatement(null);
      } finally {
        if (
          statementItemsRequest.isCurrent(request) &&
          workspaceRequests.isCurrent(workspaceRequest)
        ) {
          if (append) {
            setLoadingMoreStatementItems(false);
          } else {
            setLoadingStatementItems(false);
          }
        }
      }
    },
    [adapter, statementItemsRequest, workspaceId, workspaceRequests],
  );

  useEffect(() => {
    if (!viewingStatementId) {
      statementItemsRequest.invalidate();
      setStatementItems([]);
      setStatementItemsNextCursor(null);
      setStatementItemsHasMore(false);
      setLoadingStatementItems(false);
      setLoadingMoreStatementItems(false);
      return;
    }
    void loadStatementItems(viewingStatementId, undefined, false);
    return () => statementItemsRequest.invalidate();
  }, [loadStatementItems, statementItemsRequest, viewingStatementId]);

  const loadTransactionAudit = useCallback(
    async (transactionId: string, cursor: string | undefined, append: boolean) => {
      const request = transactionAuditRequest.begin();
      const workspaceRequest = workspaceRequests.begin(workspaceId);
      if (append) {
        setLoadingMoreTransactionAudit(true);
      } else {
        setTransactionAudit([]);
        setTransactionAuditNextCursor(null);
        setTransactionAuditHasMore(false);
        setSelectedAuditId(null);
        setSelectedAudit(null);
        setLoadingTransactionAudit(true);
      }
      setTransactionAuditError(null);
      try {
        const page = await adapter.listTransactionAudit(workspaceId, transactionId, {
          cursor,
          limit: 50,
        });
        if (
          !transactionAuditRequest.isCurrent(request) ||
          !workspaceRequests.isCurrent(workspaceRequest)
        )
          return;
        setTransactionAudit((current) => (append ? [...current, ...page.items] : page.items));
        setTransactionAuditNextCursor(page.nextCursor);
        setTransactionAuditHasMore(page.hasMore);
        if (!append) setSelectedAuditId(page.items[0]?.id ?? null);
      } catch (cause) {
        if (
          !transactionAuditRequest.isCurrent(request) ||
          !workspaceRequests.isCurrent(workspaceRequest)
        )
          return;
        setTransactionAuditError(
          cause instanceof Error ? cause.message : "Não foi possível carregar o histórico.",
        );
      } finally {
        if (
          transactionAuditRequest.isCurrent(request) &&
          workspaceRequests.isCurrent(workspaceRequest)
        ) {
          if (append) setLoadingMoreTransactionAudit(false);
          else setLoadingTransactionAudit(false);
        }
      }
    },
    [adapter, transactionAuditRequest, workspaceId, workspaceRequests],
  );

  const viewingTransactionId = visibleViewingTransaction?.id;

  useEffect(() => {
    if (!viewingTransactionId) {
      transactionAuditRequest.invalidate();
      transactionAuditDetailRequest.invalidate();
      setTransactionAudit([]);
      setTransactionAuditNextCursor(null);
      setTransactionAuditHasMore(false);
      setLoadingTransactionAudit(false);
      setLoadingMoreTransactionAudit(false);
      setTransactionAuditError(null);
      setSelectedAuditId(null);
      setSelectedAudit(null);
      setLoadingAuditDetail(false);
      return;
    }
    void loadTransactionAudit(viewingTransactionId, undefined, false);
    return () => {
      transactionAuditRequest.invalidate();
      transactionAuditDetailRequest.invalidate();
    };
  }, [
    loadTransactionAudit,
    transactionAuditDetailRequest,
    transactionAuditRequest,
    viewingTransactionId,
  ]);

  useEffect(() => {
    if (!viewingTransactionId || !selectedAuditId) {
      transactionAuditDetailRequest.invalidate();
      setSelectedAudit(null);
      setLoadingAuditDetail(false);
      return;
    }
    const request = transactionAuditDetailRequest.begin();
    const workspaceRequest = workspaceRequests.begin(workspaceId);
    setLoadingAuditDetail(true);
    void adapter
      .getTransactionAudit(workspaceId, viewingTransactionId, selectedAuditId)
      .then((detail) => {
        if (
          transactionAuditDetailRequest.isCurrent(request) &&
          workspaceRequests.isCurrent(workspaceRequest)
        )
          setSelectedAudit(detail);
      })
      .catch((cause: unknown) => {
        if (
          transactionAuditDetailRequest.isCurrent(request) &&
          workspaceRequests.isCurrent(workspaceRequest)
        ) {
          setSelectedAudit(null);
          setTransactionAuditError(
            cause instanceof Error ? cause.message : "Não foi possível carregar o evento.",
          );
        }
      })
      .finally(() => {
        if (
          transactionAuditDetailRequest.isCurrent(request) &&
          workspaceRequests.isCurrent(workspaceRequest)
        )
          setLoadingAuditDetail(false);
      });
    return () => transactionAuditDetailRequest.invalidate();
  }, [
    adapter,
    selectedAuditId,
    transactionAuditDetailRequest,
    viewingTransactionId,
    workspaceId,
    workspaceRequests,
  ]);

  function openStatementPayment(statement: Statement) {
    setPendingStatementPayment(statement);
    setStatementPaymentAmount(statement.openAmount.minor);
    setError(null);
  }

  async function payStatement(statement: Statement, amountMinor: string) {
    if (busyStatementId || BigInt(statement.openAmount.minor) <= BigInt(0)) return;
    let parsedAmount: bigint;
    try {
      parsedAmount = BigInt(amountMinor || "0");
    } catch {
      setError("Informe um valor monetário válido para o pagamento.");
      return;
    }
    if (parsedAmount <= BigInt(0) || parsedAmount > BigInt(statement.openAmount.minor)) {
      setError("O pagamento deve ser maior que zero e não pode superar o valor em aberto.");
      return;
    }
    setBusyStatementId(statement.id);
    setError(null);
    const workspaceRequest = workspaceRequests.begin(workspaceId);
    const commandKey =
      statementPaymentCommandKey.current ?? `web-statement-payment-${crypto.randomUUID()}`;
    statementPaymentCommandKey.current = commandKey;
    try {
      await adapter.payStatement(
        workspaceId,
        statement,
        {
          currency: statement.openAmount.currency,
          minor: parsedAmount.toString(),
        },
        commandKey,
      );
      if (!workspaceRequests.isCurrent(workspaceRequest)) return;
      statementPaymentCommandKey.current = null;
      await load();
      if (!workspaceRequests.isCurrent(workspaceRequest)) return;
      setNotice("Pagamento registrado na carteira.");
      setPendingStatementPayment(null);
    } catch (cause) {
      if (!workspaceRequests.isCurrent(workspaceRequest)) return;
      if (!shouldRetryIdempotentCommand(cause)) statementPaymentCommandKey.current = null;
      setError(cause instanceof Error ? cause.message : "Não foi possível pagar a fatura.");
    } finally {
      if (workspaceRequests.isCurrent(workspaceRequest)) setBusyStatementId(null);
    }
  }

  async function handleStatementPaymentSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pendingStatementPayment || payingStatement) return;
    setPayingStatement(true);
    try {
      await payStatement(pendingStatementPayment, statementPaymentAmount);
    } finally {
      setPayingStatement(false);
    }
  }

  function openWalletAdjustment() {
    if (!visibleWallet || !writeAccess) return;
    setObservedWalletBalance(visibleWallet.balance.minor);
    setWalletAdjustmentReason("");
    setWalletAdjustmentPreview(null);
    setWalletAdjustmentError(null);
    setWalletAdjustmentConfirmed(false);
    walletAdjustmentCommandKey.current = null;
    setWalletAdjustmentOpen(true);
  }

  async function handleWalletAdjustmentPreview(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (walletAdjustmentPreview) {
      await handleWalletAdjustmentConfirm();
      return;
    }
    if (!visibleWallet || previewingWalletAdjustment || savingWalletAdjustment || !writeAccess)
      return;
    setPreviewingWalletAdjustment(true);
    setWalletAdjustmentError(null);
    setNotice(null);
    const workspaceRequest = workspaceRequests.begin(workspaceId);
    try {
      const preview = await adapter.previewWalletAdjustment(workspaceId, {
        currency: visibleWallet.balance.currency,
        minor: observedWalletBalance,
      });
      if (!workspaceRequests.isCurrent(workspaceRequest)) return;
      setWallet(preview.wallet);
      setWalletAdjustmentPreview(preview);
      walletAdjustmentCommandKey.current = null;
    } catch (cause) {
      if (!workspaceRequests.isCurrent(workspaceRequest)) return;
      setWalletAdjustmentError(
        cause instanceof Error ? cause.message : "Não foi possível conferir o saldo informado.",
      );
    } finally {
      if (workspaceRequests.isCurrent(workspaceRequest)) setPreviewingWalletAdjustment(false);
    }
  }

  async function handleWalletAdjustmentConfirm() {
    if (!walletAdjustmentPreview || savingWalletAdjustment || !writeAccess) return;
    if (BigInt(walletAdjustmentPreview.difference.minor) === BigInt(0)) {
      setWalletAdjustmentOpen(false);
      return;
    }
    const reason = walletAdjustmentReason.trim();
    if (!reason) {
      setWalletAdjustmentError("Conte brevemente por que o saldo está diferente.");
      return;
    }
    setSavingWalletAdjustment(true);
    setWalletAdjustmentError(null);
    setNotice(null);
    const workspaceRequest = workspaceRequests.begin(workspaceId);
    const commandKey =
      walletAdjustmentCommandKey.current ?? `web-wallet-adjustment-${crypto.randomUUID()}`;
    walletAdjustmentCommandKey.current = commandKey;
    try {
      const result = await adapter.adjustWallet(
        workspaceId,
        walletAdjustmentPreview.wallet,
        {
          observedBalance: walletAdjustmentPreview.observedBalance,
          reason,
        },
        commandKey,
      );
      if (!workspaceRequests.isCurrent(workspaceRequest)) return;
      walletAdjustmentCommandKey.current = null;
      setWallet(result.wallet);
      setWalletAdjustmentOpen(false);
      setWalletAdjustmentPreview(null);
      setWalletAdjustmentReason("");
      setWalletAdjustmentConfirmed(true);
      await load();
    } catch (cause) {
      if (!workspaceRequests.isCurrent(workspaceRequest)) return;
      if (cause instanceof FinanceAdapterError && cause.status === 412) {
        walletAdjustmentCommandKey.current = null;
        setWalletAdjustmentPreview(null);
        try {
          const currentWallet = await adapter.getWallet(workspaceId);
          if (!workspaceRequests.isCurrent(workspaceRequest)) return;
          setWallet(currentWallet);
          setWalletAdjustmentError(
            "A carteira mudou enquanto você conferia. O saldo atual foi recarregado; calcule a diferença novamente.",
          );
        } catch (reloadCause) {
          if (!workspaceRequests.isCurrent(workspaceRequest)) return;
          setWalletAdjustmentError(
            reloadCause instanceof Error
              ? reloadCause.message
              : "A carteira mudou e não foi possível recarregar o saldo.",
          );
        }
      } else {
        if (!shouldRetryIdempotentCommand(cause)) walletAdjustmentCommandKey.current = null;
        setWalletAdjustmentError(
          cause instanceof Error ? cause.message : "Não foi possível ajustar a carteira.",
        );
      }
    } finally {
      if (workspaceRequests.isCurrent(workspaceRequest)) setSavingWalletAdjustment(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="text-sm text-muted-foreground">Carteira e compromissos</p>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight">Finanças</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            Registre o essencial agora. Faturas, parcelas e compromissos ficam no mesmo lugar.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => void load()}
          disabled={visibleStatus === "loading"}
        >
          <RefreshCwIcon aria-hidden="true" /> Atualizar
        </Button>
      </header>

      {visibleNotice ? (
        <Alert role="status">
          <CheckIcon aria-hidden="true" />
          <AlertTitle>{visibleNotice}</AlertTitle>
          <AlertDescription>
            <span className="flex flex-wrap items-center gap-3">
              <span>Você pode continuar registrando ou revisar a linha do tempo abaixo.</span>
              {undoableTransaction ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void undoTransaction()}
                  disabled={undoing || !writeAccess}
                >
                  {undoing ? "Desfazendo…" : "Desfazer"}
                </Button>
              ) : null}
            </span>
          </AlertDescription>
        </Alert>
      ) : null}
      {visibleError ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Não foi possível concluir</AlertTitle>
          <AlertDescription>{visibleError}</AlertDescription>
        </Alert>
      ) : null}

      <section className="grid gap-4 md:grid-cols-3" aria-label="Resumo financeiro">
        <Card className="bg-primary text-primary-foreground">
          <CardHeader>
            <CardDescription className="text-primary-foreground/70">
              Saldo atual da carteira
            </CardDescription>
            <CardTitle className="text-3xl font-semibold tracking-tight">
              {visibleWallet
                ? formatMoneyMinor(visibleWallet.balance.minor, visibleWallet.balance.currency)
                : "Carregando…"}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col items-start gap-3 text-sm text-primary-foreground/80">
            <p>
              Calculado pelo histórico completo da carteira, mesmo quando a linha do tempo é
              filtrada.
            </p>
            {walletAdjustmentConfirmed ? (
              <p role="status" className="font-medium text-primary-foreground">
                Saldo conferido. A carteira foi ajustada pela diferença.
              </p>
            ) : null}
            {writeAccess ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={openWalletAdjustment}
                disabled={!visibleWallet || visibleStatus === "loading"}
              >
                Conferir saldo
              </Button>
            ) : (
              <p>Somente membros que podem editar as finanças conferem este saldo.</p>
            )}
          </CardContent>
        </Card>
        <Card id="safe-to-spend">
          <CardHeader>
            <CardDescription>Valor seguro para gastar</CardDescription>
            <CardTitle className="text-2xl font-semibold">Ainda não calculado</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Registre saldo inicial e compromissos para aumentar a confiança.
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Cartões ativos</CardDescription>
            <CardTitle className="text-3xl font-semibold">
              {visibleCards.filter((card) => !card.archived).length}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Compras no cartão não reduzem o saldo até o pagamento da fatura.
          </CardContent>
        </Card>
      </section>

      <section aria-labelledby="quick-entry-title">
        <Card>
          <CardHeader>
            <div className="flex items-start gap-3">
              <ReceiptTextIcon aria-hidden="true" />
              <div>
                <CardTitle id="quick-entry-title">Adicionar lançamento</CardTitle>
                <CardDescription>Valor é o único campo obrigatório.</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-4 md:grid-cols-[auto_auto_1fr_1.4fr_auto] md:items-end"
              onSubmit={handleTransactionSubmit}
            >
              <Field>
                <FieldLabel htmlFor="transaction-kind">Tipo</FieldLabel>
                <select
                  id="transaction-kind"
                  className="h-8 rounded-lg border border-input bg-background px-2.5 text-sm"
                  value={transactionType}
                  onChange={(event) => {
                    const nextType = event.target.value as "expense" | "income";
                    setTransactionType(nextType);
                    if (nextType === "income") {
                      setTransactionCardId("");
                      setTransactionCategoryId("");
                    }
                  }}
                >
                  <option value="expense">Despesa</option>
                  <option value="income">Receita</option>
                </select>
              </Field>
              <Field>
                <FieldLabel htmlFor="transaction-instrument">Onde?</FieldLabel>
                <select
                  id="transaction-instrument"
                  className="h-8 rounded-lg border border-input bg-background px-2.5 text-sm"
                  value={transactionCardId}
                  disabled={transactionType === "income"}
                  onChange={(event) => setTransactionCardId(event.target.value)}
                >
                  <option value="">Carteira</option>
                  {visibleCards
                    .filter((card) => !card.archived)
                    .map((card) => (
                      <option key={card.id} value={card.id}>
                        {card.name}
                      </option>
                    ))}
                </select>
              </Field>
              <MoneyInput value={amount} onChange={setAmount} label="Valor" currency={currency} />
              <details className="rounded-lg border border-dashed px-3 py-2 md:col-span-2">
                <summary className="cursor-pointer text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
                  Mais detalhes
                </summary>
                <div className="pt-3">
                  <Field>
                    <FieldLabel htmlFor="transaction-description">Descrição (opcional)</FieldLabel>
                    <Input
                      id="transaction-description"
                      value={description}
                      onChange={(event) => setDescription(event.target.value)}
                      placeholder="Ex.: mercado"
                      maxLength={500}
                    />
                    <FieldDescription>Você pode detalhar depois.</FieldDescription>
                  </Field>
                  <Field className="mt-3">
                    <FieldLabel htmlFor="transaction-category">Categoria (opcional)</FieldLabel>
                    <select
                      id="transaction-category"
                      className="h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm"
                      value={transactionCategoryId}
                      onChange={(event) => setTransactionCategoryId(event.target.value)}
                    >
                      <option value="">Sem categoria</option>
                      {visibleCategories
                        .filter(
                          (category) =>
                            !category.archived &&
                            (category.kind === "both" || category.kind === transactionType),
                        )
                        .map((category) => (
                          <option key={category.id} value={category.id}>
                            {category.name}
                          </option>
                        ))}
                    </select>
                  </Field>
                </div>
              </details>
              <div className="flex flex-col gap-2">
                <label className="flex min-h-8 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={planned}
                    onChange={(event) => setPlanned(event.target.checked)}
                  />{" "}
                  Planejada
                </label>
                <Button type="submit" disabled={saving || !writeAccess}>
                  {saving ? (
                    <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                  ) : (
                    <PlusIcon aria-hidden="true" />
                  )}
                  Salvar
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </section>

      <section aria-labelledby="categories-title">
        <Card>
          <CardHeader>
            <CardTitle id="categories-title">Categorias</CardTitle>
            <CardDescription>
              Organize receitas e despesas sem apagar o histórico. Categorias arquivadas continuam
              visíveis nos lançamentos antigos.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.8fr)]">
            <form
              className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end"
              onSubmit={handleCategorySubmit}
            >
              <Field>
                <FieldLabel htmlFor="category-name">Nome</FieldLabel>
                <Input
                  id="category-name"
                  value={categoryName}
                  onChange={(event) => setCategoryName(event.target.value)}
                  placeholder="Ex.: Mercado"
                  maxLength={80}
                  disabled={!writeAccess || savingCategory}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="category-kind">Tipo</FieldLabel>
                <select
                  id="category-kind"
                  className="h-8 rounded-lg border border-input bg-background px-2.5 text-sm"
                  value={categoryKind}
                  onChange={(event) => setCategoryKind(event.target.value as Category["kind"])}
                  disabled={!writeAccess || savingCategory}
                >
                  <option value="expense">Despesa</option>
                  <option value="income">Receita</option>
                  <option value="both">Receita e despesa</option>
                </select>
              </Field>
              <div className="flex gap-2">
                <Button
                  type="submit"
                  disabled={!writeAccess || savingCategory || !categoryName.trim()}
                >
                  {savingCategory ? (
                    <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                  ) : (
                    <PlusIcon aria-hidden="true" />
                  )}
                  {editingCategory ? "Salvar" : "Adicionar"}
                </Button>
                {editingCategory ? (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setEditingCategory(null);
                      setCategoryName("");
                      setCategoryKind("expense");
                    }}
                    disabled={savingCategory}
                  >
                    Cancelar
                  </Button>
                ) : null}
              </div>
            </form>
            <div className="rounded-lg border bg-muted/20 p-3" aria-live="polite">
              {visibleCategories.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Nenhuma categoria cadastrada. A primeira pode ser criada acima.
                </p>
              ) : (
                <ul className="divide-y">
                  {visibleCategories.map((category) => (
                    <li
                      key={category.id}
                      className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{category.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {category.kind === "both"
                            ? "Receita e despesa"
                            : category.kind === "income"
                              ? "Receita"
                              : "Despesa"}
                          {category.archived ? " · Arquivada" : ""}
                        </p>
                      </div>
                      {writeAccess ? (
                        <div className="flex shrink-0 gap-1">
                          {!category.archived ? (
                            <>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                aria-label={`Editar categoria ${category.name}`}
                                onClick={() => {
                                  setEditingCategory(category);
                                  setCategoryName(category.name);
                                  setCategoryKind(category.kind);
                                }}
                                disabled={savingCategory}
                              >
                                <PencilIcon aria-hidden="true" />
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                onClick={() => void transitionCategory(category, "archive")}
                                disabled={savingCategory}
                              >
                                Arquivar
                              </Button>
                            </>
                          ) : (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => void transitionCategory(category, "restore")}
                              disabled={savingCategory}
                            >
                              Restaurar
                            </Button>
                          )}
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Linha do tempo</CardTitle>
            <CardDescription>
              Entradas, saídas e compromissos do espaço. Filtros ficam salvos neste endereço.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="mb-5 grid gap-3 rounded-lg border bg-muted/20 p-3 sm:grid-cols-2 lg:grid-cols-3"
              onSubmit={applyTimelineFilters}
              aria-label="Filtrar linha do tempo"
            >
              <Field className="sm:col-span-2 lg:col-span-3">
                <FieldLabel htmlFor="timeline-search">Buscar por descrição</FieldLabel>
                <div className="relative">
                  <SearchIcon
                    aria-hidden="true"
                    className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                  />
                  <Input
                    id="timeline-search"
                    value={timelineSearch}
                    onChange={(event) => setTimelineSearch(event.target.value)}
                    placeholder="Ex.: mercado"
                    className="pl-9"
                    maxLength={100}
                  />
                </div>
              </Field>
              <Field>
                <FieldLabel htmlFor="timeline-from">De</FieldLabel>
                <Input
                  id="timeline-from"
                  type="date"
                  value={timelineFrom}
                  onChange={(event) => setTimelineFrom(event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="timeline-to">Até</FieldLabel>
                <Input
                  id="timeline-to"
                  type="date"
                  value={timelineTo}
                  onChange={(event) => setTimelineTo(event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="timeline-state">Estado</FieldLabel>
                <select
                  id="timeline-state"
                  className="h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm"
                  value={timelineState}
                  onChange={(event) =>
                    setTimelineState(event.target.value as "" | Transaction["state"])
                  }
                >
                  <option value="">Todos</option>
                  <option value="posted">Realizadas</option>
                  <option value="planned">Planejadas</option>
                  <option value="partially_settled">Parciais</option>
                  <option value="canceled">Canceladas</option>
                </select>
              </Field>
              <Field>
                <FieldLabel htmlFor="timeline-kind">Tipo</FieldLabel>
                <select
                  id="timeline-kind"
                  className="h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm"
                  value={timelineKind}
                  onChange={(event) =>
                    setTimelineKind(event.target.value as "" | Transaction["kind"])
                  }
                >
                  <option value="">Todos</option>
                  <option value="expense">Despesas</option>
                  <option value="income">Receitas</option>
                  <option value="transfer">Transferências</option>
                  <option value="adjustment">Ajustes</option>
                </select>
              </Field>
              <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-3">
                <Button type="submit" size="sm">
                  <SearchIcon aria-hidden="true" /> Aplicar filtros
                </Button>
                {hasTimelineFilters ? (
                  <Button type="button" size="sm" variant="ghost" onClick={clearTimelineFilters}>
                    <XIcon aria-hidden="true" /> Limpar
                  </Button>
                ) : null}
              </div>
            </form>
            {visibleStatus === "loading" ? (
              <p role="status" className="text-sm text-muted-foreground">
                Carregando lançamentos…
              </p>
            ) : visibleTransactions.length === 0 ? (
              <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                {hasTimelineFilters
                  ? "Nenhum lançamento corresponde aos filtros. Tente limpar ou ampliar o período."
                  : "Nenhum lançamento ainda. Comece pelo valor acima."}
              </p>
            ) : (
              <>
                <ul className="divide-y">
                  {visibleTransactions.map((transaction) => (
                    <li
                      key={transaction.id}
                      className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                    >
                      <div className="min-w-0">
                        <p className="truncate font-medium">{transactionLabel(transaction)}</p>
                        <p className="text-sm text-muted-foreground">
                          {transactionKindLabel(transaction)} · {transaction.occurredOn} ·{" "}
                          {transaction.state === "planned"
                            ? "Planejada"
                            : transaction.state === "canceled"
                              ? "Cancelada"
                              : transaction.state === "partially_settled"
                                ? "Parcial"
                                : "Realizada"}
                        </p>
                      </div>
                      <span
                        className={
                          transaction.state === "canceled"
                            ? "font-semibold text-muted-foreground line-through"
                            : transaction.kind === "income"
                              ? "font-semibold text-emerald-700"
                              : "font-semibold text-foreground"
                        }
                      >
                        {transactionAmountPrefix(transaction.kind)}
                        {formatMoneyMinor(transaction.amount.minor, transaction.amount.currency)}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setViewingTransaction(transaction)}
                        aria-label={`Ver detalhes de ${transactionLabel(transaction)}`}
                      >
                        Detalhes
                      </Button>
                    </li>
                  ))}
                </ul>
                {transactionsHasMore ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="mt-4"
                    onClick={() => updateTimelineQuery({ cursor: transactionsNextCursor })}
                    disabled={!transactionsNextCursor}
                  >
                    Carregar mais lançamentos
                  </Button>
                ) : null}
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <CreditCardIcon aria-hidden="true" />
                <div>
                  <CardTitle>Cartões e faturas</CardTitle>
                  <CardDescription>O dinheiro sai só quando a fatura é paga.</CardDescription>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowCardForm((value) => !value)}
                aria-expanded={showCardForm}
                disabled={!writeAccess}
              >
                <PlusIcon aria-hidden="true" /> Cartão
              </Button>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {showCardForm ? (
              <form
                className="grid gap-3 rounded-lg border bg-muted/30 p-3"
                onSubmit={handleCardSubmit}
              >
                <Field>
                  <FieldLabel htmlFor="card-name">Nome do cartão</FieldLabel>
                  <Input
                    id="card-name"
                    value={cardName}
                    onChange={(event) => setCardName(event.target.value)}
                    required
                    placeholder="Ex.: Cartão principal"
                  />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field>
                    <FieldLabel htmlFor="card-closing">Fecha dia</FieldLabel>
                    <Input
                      id="card-closing"
                      type="number"
                      min={1}
                      max={31}
                      value={closingDay}
                      onChange={(event) => setClosingDay(event.target.value)}
                      required
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="card-due">Vence dia</FieldLabel>
                    <Input
                      id="card-due"
                      type="number"
                      min={1}
                      max={31}
                      value={dueDay}
                      onChange={(event) => setDueDay(event.target.value)}
                      required
                    />
                  </Field>
                </div>
                <Button type="submit" disabled={savingCard}>
                  {savingCard ? "Salvando…" : "Salvar cartão"}
                </Button>
              </form>
            ) : null}
            {visibleCards.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nenhum cartão cadastrado.</p>
            ) : null}
            {visibleCards.map((card) => (
              <div key={card.id} className="rounded-lg border p-3">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="font-medium">
                      {card.name}
                      {card.archived ? (
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                          Arquivado
                        </span>
                      ) : null}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      Fecha {card.closingDay} · vence {card.dueDay}
                      {card.lastFour ? ` · •••• ${card.lastFour}` : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={`Editar ${card.name}`}
                      onClick={() => openCardEditor(card)}
                      disabled={!writeAccess || savingCardEdit || archivingCardId !== null}
                    >
                      <PencilIcon aria-hidden="true" />
                      <span className="sr-only">Editar</span>
                    </Button>
                    {!card.archived ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={`Arquivar ${card.name}`}
                        onClick={() => setPendingCardArchive(card)}
                        disabled={!writeAccess || savingCardEdit || archivingCardId !== null}
                      >
                        <ArchiveIcon aria-hidden="true" />
                        <span className="sr-only">Arquivar</span>
                      </Button>
                    ) : null}
                  </div>
                </div>
                {visibleStatements
                  .filter((statement) => statement.cardId === card.id)
                  .map((statement) => (
                    <div
                      key={statement.id}
                      className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t pt-3 text-sm"
                    >
                      <div>
                        <p className="font-medium">Fatura até {statement.closingOn}</p>
                        <p className="text-muted-foreground">
                          {statementLabel(statement)} · vence {statement.dueOn}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="font-semibold">
                          {formatMoneyMinor(
                            statement.openAmount.minor,
                            statement.openAmount.currency,
                          )}
                        </p>
                        <div className="mt-1 flex gap-2">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setViewingStatement(statement)}
                          >
                            <ListTreeIcon data-icon="inline-start" aria-hidden="true" />
                            Composição
                          </Button>
                          {statement.state === "open" ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busyStatementId !== null || !writeAccess}
                              onClick={() =>
                                setPendingStatementAction({ type: "close", statement })
                              }
                            >
                              Fechar
                            </Button>
                          ) : null}
                          {statement.state === "closed" &&
                          BigInt(statement.paid.minor) === BigInt(0) ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busyStatementId !== null || !writeAccess}
                              onClick={() =>
                                setPendingStatementAction({ type: "reopen", statement })
                              }
                            >
                              <RotateCcwIcon data-icon="inline-start" aria-hidden="true" />
                              Reabrir
                            </Button>
                          ) : null}
                          {statement.state !== "paid" &&
                          statement.state !== "canceled" &&
                          BigInt(statement.openAmount.minor) > BigInt(0) ? (
                            <Button
                              size="sm"
                              disabled={busyStatementId !== null || !writeAccess}
                              onClick={() => openStatementPayment(statement)}
                            >
                              {busyStatementId === statement.id ? "Pagando…" : "Pagar"}
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  ))}
              </div>
            ))}
          </CardContent>
        </Card>
      </section>

      <Card id="commitments">
        <CardHeader>
          <div className="flex items-start gap-3">
            <CalendarClockIcon aria-hidden="true" />
            <div>
              <CardTitle>Compromissos</CardTitle>
              <CardDescription>
                Veja o que vence, confirme o valor efetivo e liquide sem misturar o planejado com o
                saldo de hoje.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="grid gap-5">
          {commitments.length === 0 ? (
            <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              Nenhum compromisso próximo ou vencido. Compromissos futuros continuam fora do saldo
              até serem liquidados.
            </p>
          ) : (
            <div className="grid gap-5 md:grid-cols-2">
              {[
                { title: "Vencidos", items: overdueCommitments },
                { title: "Próximos", items: upcomingCommitments },
              ].map(({ title, items }) => (
                <section
                  key={title}
                  aria-labelledby={`commitments-${title}`}
                  className="grid gap-2"
                >
                  <h3 id={`commitments-${title}`} className="text-sm font-semibold">
                    {title} <span className="text-muted-foreground">({items.length})</span>
                  </h3>
                  {items.length === 0 ? (
                    <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
                      Nenhum compromisso.
                    </p>
                  ) : (
                    <ul className="grid gap-2">
                      {items.map(({ transaction }) => {
                        const remaining = commitmentRemainingMinor(transaction);
                        return (
                          <li key={transaction.id} className="rounded-lg border p-3">
                            <div className="flex flex-wrap items-start justify-between gap-3">
                              <div className="min-w-0">
                                <p className="truncate font-medium">
                                  {transactionLabel(transaction)}
                                </p>
                                <p className="text-sm text-muted-foreground">
                                  Vence em {transaction.dueOn} ·{" "}
                                  {transaction.state === "partially_settled"
                                    ? "parcial"
                                    : "planejado"}
                                </p>
                              </div>
                              <div className="shrink-0 text-right">
                                <p className="font-semibold">
                                  {transactionAmountPrefix(transaction.kind)}
                                  {formatMoneyMinor(remaining, transaction.amount.currency)}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                  de{" "}
                                  {formatMoneyMinor(
                                    transaction.amount.minor,
                                    transaction.amount.currency,
                                  )}
                                </p>
                              </div>
                            </div>
                            <Button
                              type="button"
                              size="sm"
                              className="mt-3"
                              onClick={() => openSettlement(transaction)}
                              disabled={!writeAccess || settling}
                            >
                              Liquidar
                            </Button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </section>
              ))}
            </div>
          )}
          {transactionsHasMore ? (
            <p className="text-xs text-muted-foreground">
              Há mais lançamentos na linha do tempo. Carregue mais para revisar outros compromissos.
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2 border-t pt-4">
            <Button
              type="button"
              onClick={() => setShowRecurrenceForm(true)}
              disabled={!writeAccess}
            >
              <RefreshCwIcon data-icon="inline-start" aria-hidden="true" />
              Nova recorrência
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setShowInstallmentForm(true)}
              disabled={!writeAccess}
            >
              <CalendarClockIcon data-icon="inline-start" aria-hidden="true" />
              Novo parcelamento
            </Button>
          </div>
        </CardContent>
      </Card>

      <Dialog
        open={settlingTransaction !== null}
        onOpenChange={(open) => {
          if (!open && !settling) {
            settlementCommandKey.current = null;
            setSettlingTransaction(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Liquidar compromisso</DialogTitle>
            <DialogDescription>
              Informe o valor efetivo. Um valor menor mantém o restante planejado; o valor cheio
              publica a liquidação total.
            </DialogDescription>
          </DialogHeader>
          {settlingTransaction ? (
            <form className="grid gap-4" onSubmit={handleSettlementSubmit}>
              <p className="rounded-lg bg-muted/50 p-3 text-sm">
                {transactionLabel(settlingTransaction)} · restante{" "}
                <strong>
                  {formatMoneyMinor(
                    commitmentRemainingMinor(settlingTransaction),
                    settlingTransaction.amount.currency,
                  )}
                </strong>
              </p>
              <MoneyInput
                id="settlement-amount"
                value={settlementAmount}
                onChange={setSettlementAmount}
                label="Valor efetivo"
                currency={currency}
                disabled={settling}
              />
              <Field>
                <FieldLabel htmlFor="settlement-date">Data efetiva</FieldLabel>
                <Input
                  id="settlement-date"
                  type="date"
                  value={settlementDate}
                  onChange={(event) => setSettlementDate(event.target.value)}
                  disabled={settling}
                />
              </Field>
              {settlementError ? (
                <p className="text-sm text-destructive" role="alert">
                  {settlementError}
                </p>
              ) : null}
              <DialogFooter>
                <DialogClose
                  render={<Button type="button" variant="outline" />}
                  disabled={settling}
                >
                  Cancelar
                </DialogClose>
                <Button type="submit" disabled={settling || !writeAccess}>
                  {settling ? "Salvando…" : "Confirmar liquidação"}
                </Button>
              </DialogFooter>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog
        open={showRecurrenceForm}
        onOpenChange={(open) => {
          setShowRecurrenceForm(open);
          if (!open && !savingRecurrence) recurrenceCommandKey.current = null;
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Nova recorrência</DialogTitle>
            <DialogDescription>
              A prévia inicial é materializada pelo servidor até 12 meses. Recorrência variável pede
              o valor efetivo quando cada ocorrência for liquidada.
            </DialogDescription>
          </DialogHeader>
          <form className="grid gap-4" onSubmit={handleRecurrenceSubmit}>
            <div className="grid grid-cols-2 gap-3">
              <Field>
                <FieldLabel htmlFor="recurrence-kind">Tipo</FieldLabel>
                <select
                  id="recurrence-kind"
                  className="h-9 rounded-lg border border-input bg-background px-2.5 text-sm"
                  value={recurrenceKind}
                  onChange={(event) =>
                    setRecurrenceKind(event.target.value as "expense" | "income")
                  }
                >
                  <option value="expense">Despesa</option>
                  <option value="income">Receita</option>
                </select>
              </Field>
              <Field>
                <FieldLabel htmlFor="recurrence-frequency">Frequência</FieldLabel>
                <select
                  id="recurrence-frequency"
                  className="h-9 rounded-lg border border-input bg-background px-2.5 text-sm"
                  value={recurrenceFrequency}
                  onChange={(event) =>
                    setRecurrenceFrequency(event.target.value as "weekly" | "monthly" | "annual")
                  }
                >
                  <option value="weekly">Semanal</option>
                  <option value="monthly">Mensal</option>
                  <option value="annual">Anual</option>
                </select>
              </Field>
            </div>
            <MoneyInput
              id="recurrence-amount"
              value={recurrenceAmount}
              onChange={setRecurrenceAmount}
              label="Valor planejado"
              currency={currency}
              disabled={savingRecurrence}
            />
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={recurrenceVariable}
                onChange={(event) => setRecurrenceVariable(event.target.checked)}
                disabled={savingRecurrence}
              />
              O valor varia a cada ocorrência
            </label>
            {recurrenceVariable ? (
              <MoneyInput
                id="recurrence-estimate"
                value={recurrenceEstimatedAmount}
                onChange={setRecurrenceEstimatedAmount}
                label="Estimativa (opcional)"
                currency={currency}
                disabled={savingRecurrence}
              />
            ) : null}
            <div className="grid grid-cols-2 gap-3">
              <Field>
                <FieldLabel htmlFor="recurrence-interval">A cada</FieldLabel>
                <Input
                  id="recurrence-interval"
                  type="number"
                  min={1}
                  max={12}
                  value={recurrenceInterval}
                  onChange={(event) => setRecurrenceInterval(event.target.value)}
                  disabled={savingRecurrence}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="recurrence-start">Começa em</FieldLabel>
                <Input
                  id="recurrence-start"
                  type="date"
                  value={recurrenceStartOn || today}
                  onChange={(event) => setRecurrenceStartOn(event.target.value)}
                  disabled={savingRecurrence}
                />
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="recurrence-end">Termina em (opcional)</FieldLabel>
              <Input
                id="recurrence-end"
                type="date"
                value={recurrenceEndOn}
                onChange={(event) => setRecurrenceEndOn(event.target.value)}
                disabled={savingRecurrence}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="recurrence-description">Descrição (opcional)</FieldLabel>
              <Input
                id="recurrence-description"
                value={recurrenceDescription}
                onChange={(event) => setRecurrenceDescription(event.target.value)}
                maxLength={500}
                disabled={savingRecurrence}
              />
            </Field>
            <DialogFooter>
              <DialogClose
                render={<Button type="button" variant="outline" />}
                disabled={savingRecurrence}
              >
                Cancelar
              </DialogClose>
              <Button type="submit" disabled={savingRecurrence || !writeAccess}>
                {savingRecurrence ? "Criando…" : "Criar recorrência"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={showInstallmentForm}
        onOpenChange={(open) => {
          setShowInstallmentForm(open);
          if (!open && !savingInstallment) installmentCommandKey.current = null;
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Novo parcelamento</DialogTitle>
            <DialogDescription>
              O servidor distribui os centavos exatamente. Confira a prévia antes de criar as
              parcelas planejadas.
            </DialogDescription>
          </DialogHeader>
          <form className="grid gap-4" onSubmit={handleInstallmentSubmit}>
            <MoneyInput
              id="installment-total"
              value={installmentTotal}
              onChange={setInstallmentTotal}
              label="Total"
              currency={currency}
              disabled={savingInstallment}
            />
            <div className="grid grid-cols-2 gap-3">
              <Field>
                <FieldLabel htmlFor="installment-count">Quantidade</FieldLabel>
                <Input
                  id="installment-count"
                  type="number"
                  min={2}
                  max={999}
                  value={installmentCount}
                  onChange={(event) => setInstallmentCount(event.target.value)}
                  disabled={savingInstallment}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="installment-first-due">Primeiro vencimento</FieldLabel>
                <Input
                  id="installment-first-due"
                  type="date"
                  value={installmentFirstDueOn || today}
                  onChange={(event) => setInstallmentFirstDueOn(event.target.value)}
                  disabled={savingInstallment}
                />
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="installment-description">Descrição (opcional)</FieldLabel>
              <Input
                id="installment-description"
                value={installmentDescription}
                onChange={(event) => setInstallmentDescription(event.target.value)}
                maxLength={500}
                disabled={savingInstallment}
              />
            </Field>
            {installmentPreview.length > 0 ? (
              <div className="rounded-lg border bg-muted/20 p-3">
                <p className="text-sm font-semibold">Prévia</p>
                <ul className="mt-2 grid max-h-40 gap-1 overflow-y-auto text-sm">
                  {installmentPreview.map((row) => (
                    <li key={row.dueOn} className="flex justify-between gap-3">
                      <span>
                        Parcela {row.number} · {row.dueOn}
                      </span>
                      <strong>{formatMoneyMinor(row.minor, currency)}</strong>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <DialogFooter>
              <DialogClose
                render={<Button type="button" variant="outline" />}
                disabled={savingInstallment}
              >
                Cancelar
              </DialogClose>
              <Button type="submit" disabled={savingInstallment || !writeAccess}>
                {savingInstallment ? "Criando…" : "Criar parcelamento"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={pendingStatementPayment !== null}
        onOpenChange={(open) => {
          if (!open && !payingStatement && busyStatementId === null) {
            setPendingStatementPayment(null);
            statementPaymentCommandKey.current = null;
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Pagar fatura</DialogTitle>
            <DialogDescription>
              Informe o total ou um valor menor. Pagamento parcial mantém o restante em aberto e não
              cria uma nova despesa.
            </DialogDescription>
          </DialogHeader>
          {pendingStatementPayment ? (
            <form className="grid gap-4" onSubmit={handleStatementPaymentSubmit}>
              <p className="rounded-lg bg-muted/50 p-3 text-sm">
                Em aberto:{" "}
                <strong>
                  {formatMoneyMinor(
                    pendingStatementPayment.openAmount.minor,
                    pendingStatementPayment.openAmount.currency,
                  )}
                </strong>
              </p>
              <MoneyInput
                id="statement-payment-amount"
                value={statementPaymentAmount}
                onChange={setStatementPaymentAmount}
                label="Valor do pagamento"
                currency={pendingStatementPayment.openAmount.currency}
                disabled={payingStatement || busyStatementId !== null}
              />
              <DialogFooter>
                <DialogClose
                  render={<Button type="button" variant="outline" />}
                  disabled={payingStatement || busyStatementId !== null}
                >
                  Cancelar
                </DialogClose>
                <Button
                  type="submit"
                  disabled={payingStatement || busyStatementId !== null || !writeAccess}
                >
                  {payingStatement || busyStatementId !== null ? "Pagando…" : "Confirmar pagamento"}
                </Button>
              </DialogFooter>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog
        open={workspaceDataReady && walletAdjustmentOpen}
        onOpenChange={(open) => {
          if (open) return;
          if (previewingWalletAdjustment || savingWalletAdjustment) return;
          setWalletAdjustmentOpen(false);
          setWalletAdjustmentPreview(null);
          setWalletAdjustmentReason("");
          setWalletAdjustmentError(null);
          walletAdjustmentCommandKey.current = null;
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Conferir saldo da carteira</DialogTitle>
            <DialogDescription>
              Informe o saldo que você vê agora. Antes de criar qualquer registro, mostraremos
              exatamente a diferença em relação ao histórico do Casei.
            </DialogDescription>
          </DialogHeader>
          <form className="grid gap-4" onSubmit={handleWalletAdjustmentPreview}>
            <MoneyInput
              id="observed-wallet-balance"
              value={observedWalletBalance}
              onChange={(minor) => {
                setObservedWalletBalance(minor);
                setWalletAdjustmentPreview(null);
                setWalletAdjustmentError(null);
                walletAdjustmentCommandKey.current = null;
              }}
              label="Saldo que você vê agora"
              description="Pode ser positivo, zero ou negativo."
              currency={visibleWallet?.balance.currency ?? currency}
              allowNegative
              autoFocus
              disabled={previewingWalletAdjustment || savingWalletAdjustment}
            />

            {walletAdjustmentPreview && walletAdjustmentAbsoluteDifference !== null ? (
              <Alert role="status">
                <AlertTitle>
                  {walletAdjustmentDifferenceMinor === BigInt(0)
                    ? "O saldo já confere"
                    : "Diferença calculada"}
                </AlertTitle>
                <AlertDescription>
                  {walletAdjustmentDifferenceMinor === BigInt(0)
                    ? "Nenhum ajuste será criado."
                    : BigInt(walletAdjustmentPreview.difference.minor) > BigInt(0)
                      ? `Serão acrescentados ${formatMoneyMinor(
                          walletAdjustmentAbsoluteDifference.toString(),
                          walletAdjustmentPreview.difference.currency,
                        )} à carteira.`
                      : `Serão retirados ${formatMoneyMinor(
                          walletAdjustmentAbsoluteDifference.toString(),
                          walletAdjustmentPreview.difference.currency,
                        )} da carteira.`}
                </AlertDescription>
              </Alert>
            ) : null}

            {walletAdjustmentDifferenceMinor !== null &&
            walletAdjustmentDifferenceMinor !== BigInt(0) ? (
              <Field>
                <FieldLabel htmlFor="wallet-adjustment-reason">Motivo da diferença</FieldLabel>
                <Input
                  id="wallet-adjustment-reason"
                  value={walletAdjustmentReason}
                  onChange={(event) => {
                    setWalletAdjustmentReason(event.target.value);
                    setWalletAdjustmentError(null);
                  }}
                  placeholder="Ex.: tarifa bancária que ainda não registrei"
                  maxLength={500}
                  required
                  disabled={savingWalletAdjustment}
                />
                <FieldDescription>
                  Essa observação fica no histórico de auditoria do ajuste.
                </FieldDescription>
              </Field>
            ) : null}

            {walletAdjustmentError ? (
              <Alert variant="destructive" role="alert">
                <AlertTitle>Não foi possível concluir</AlertTitle>
                <AlertDescription>{walletAdjustmentError}</AlertDescription>
              </Alert>
            ) : null}

            <DialogFooter>
              <DialogClose
                render={<Button type="button" variant="outline" />}
                disabled={previewingWalletAdjustment || savingWalletAdjustment}
              >
                Cancelar
              </DialogClose>
              {walletAdjustmentPreview ? (
                <Button
                  type="button"
                  onClick={() => void handleWalletAdjustmentConfirm()}
                  disabled={
                    savingWalletAdjustment ||
                    previewingWalletAdjustment ||
                    (walletAdjustmentDifferenceMinor !== BigInt(0) &&
                      !walletAdjustmentReason.trim())
                  }
                >
                  {savingWalletAdjustment
                    ? "Ajustando…"
                    : walletAdjustmentDifferenceMinor === BigInt(0)
                      ? "Fechar"
                      : "Confirmar ajuste"}
                </Button>
              ) : (
                <Button type="submit" disabled={previewingWalletAdjustment}>
                  {previewingWalletAdjustment ? "Calculando…" : "Calcular diferença"}
                </Button>
              )}
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={visibleViewingTransaction !== null}
        onOpenChange={(open) => {
          if (!open) {
            setViewingTransaction(null);
            clearDeepLinkParam("transaction");
          }
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Detalhes do lançamento</DialogTitle>
            <DialogDescription>
              Revise a origem, o estado, a versão e o histórico de alterações deste registro.
            </DialogDescription>
          </DialogHeader>
          {visibleViewingTransaction ? (
            <dl className="grid gap-3 rounded-lg bg-muted/50 p-4 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">Descrição</dt>
                <dd className="mt-1 font-medium">{transactionLabel(visibleViewingTransaction)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Tipo</dt>
                <dd className="mt-1 font-medium">
                  {transactionKindLabel(visibleViewingTransaction)}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Valor</dt>
                <dd className="mt-1 font-medium">
                  {transactionAmountPrefix(visibleViewingTransaction.kind)}
                  {formatMoneyMinor(
                    visibleViewingTransaction.amount.minor,
                    visibleViewingTransaction.amount.currency,
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Estado</dt>
                <dd className="mt-1 font-medium">
                  {visibleViewingTransaction.state === "posted"
                    ? "Realizada"
                    : visibleViewingTransaction.state === "planned"
                      ? "Planejada"
                      : visibleViewingTransaction.state === "partially_settled"
                        ? "Parcial"
                        : "Cancelada"}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Data do fato</dt>
                <dd className="mt-1 font-medium">{visibleViewingTransaction.occurredOn}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Versão auditável</dt>
                <dd className="mt-1 font-medium">v{visibleViewingTransaction.version}</dd>
              </div>
            </dl>
          ) : null}
          <section aria-labelledby="transaction-audit-title" className="grid gap-3">
            <div>
              <h3 id="transaction-audit-title" className="font-semibold">
                Histórico de auditoria
              </h3>
              <p className="text-sm text-muted-foreground">
                Eventos preservados com snapshots sanitizados e consequências relacionadas.
              </p>
            </div>
            {loadingTransactionAudit ? (
              <p role="status" className="text-sm text-muted-foreground">
                Carregando histórico…
              </p>
            ) : visibleTransactionAuditError ? (
              <Alert variant="destructive">
                <AlertTitle>Não foi possível carregar o histórico</AlertTitle>
                <AlertDescription>{visibleTransactionAuditError}</AlertDescription>
              </Alert>
            ) : visibleTransactionAudit.length === 0 ? (
              <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
                Nenhum evento de auditoria registrado para este lançamento.
              </p>
            ) : (
              <>
                <ol aria-label="Eventos do histórico de auditoria" className="grid gap-2">
                  {visibleTransactionAudit.map((event) => (
                    <li key={event.id}>
                      <button
                        type="button"
                        className="w-full rounded-lg border p-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        aria-pressed={selectedAuditId === event.id}
                        onClick={() => setSelectedAuditId(event.id)}
                      >
                        <span className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-medium">{auditActionLabel(event.action)}</span>
                          <span className="text-xs text-muted-foreground">
                            {new Date(event.occurredAt).toLocaleString("pt-BR")}
                          </span>
                        </span>
                        <span className="mt-1 block text-sm text-muted-foreground">
                          Origem: {event.origin} · Resultado: {event.result}
                        </span>
                      </button>
                    </li>
                  ))}
                </ol>
                {transactionAuditHasMore ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      if (visibleViewingTransaction && transactionAuditNextCursor) {
                        void loadTransactionAudit(
                          visibleViewingTransaction.id,
                          transactionAuditNextCursor,
                          true,
                        );
                      }
                    }}
                    disabled={loadingMoreTransactionAudit || !transactionAuditNextCursor}
                  >
                    {loadingMoreTransactionAudit ? "Carregando…" : "Carregar mais eventos"}
                  </Button>
                ) : null}
              </>
            )}
            {loadingAuditDetail ? (
              <p role="status" className="text-sm text-muted-foreground">
                Carregando detalhes do evento…
              </p>
            ) : visibleSelectedAudit ? (
              <div className="grid gap-3 rounded-lg bg-muted/30 p-3 text-sm">
                <div className="grid gap-1 sm:grid-cols-2">
                  <p>
                    <span className="text-muted-foreground">Ação: </span>
                    <span className="font-medium">
                      {auditActionLabel(visibleSelectedAudit.action)}
                    </span>
                  </p>
                  <p>
                    <span className="text-muted-foreground">Autor: </span>
                    <code className="break-all">{visibleSelectedAudit.actorId ?? "sistema"}</code>
                  </p>
                  <p>
                    <span className="text-muted-foreground">Correlação: </span>
                    <code className="break-all">{visibleSelectedAudit.correlationId}</code>
                  </p>
                  {visibleSelectedAudit.reason ? (
                    <p>
                      <span className="text-muted-foreground">Motivo: </span>
                      {visibleSelectedAudit.reason}
                    </p>
                  ) : null}
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <h4 className="font-medium">Antes (sanitizado)</h4>
                    <pre className="mt-1 max-h-36 overflow-auto rounded border bg-background p-2 text-xs">
                      {auditSnapshotText(visibleSelectedAudit.before)}
                    </pre>
                  </div>
                  <div>
                    <h4 className="font-medium">Depois (sanitizado)</h4>
                    <pre className="mt-1 max-h-36 overflow-auto rounded border bg-background p-2 text-xs">
                      {auditSnapshotText(visibleSelectedAudit.after)}
                    </pre>
                  </div>
                </div>
                <div>
                  <h4 className="font-medium">Consequências relacionadas</h4>
                  {visibleSelectedAudit.consequences.ledgerEvents.length === 0 ? (
                    <p className="mt-1 text-muted-foreground">Nenhuma consequência publicada.</p>
                  ) : (
                    <ul className="mt-1 grid gap-1 text-muted-foreground">
                      {visibleSelectedAudit.consequences.ledgerEvents.map((event) => (
                        <li key={event.id}>
                          {event.eventType} · {event.status} · {event.occurredOn}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            ) : null}
          </section>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Fechar</DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={visibleViewingStatement !== null}
        onOpenChange={(open) => {
          if (!open) {
            setViewingStatement(null);
            clearDeepLinkParam("statement");
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Composição da fatura</DialogTitle>
            <DialogDescription>
              Compras aumentam o total. Pagamentos reduzem apenas o valor em aberto.
            </DialogDescription>
          </DialogHeader>
          {visibleViewingStatement ? (
            <div className="flex flex-col gap-4">
              <dl className="grid grid-cols-3 gap-3 rounded-lg bg-muted/50 p-3 text-sm">
                <div>
                  <dt className="text-muted-foreground">Total</dt>
                  <dd className="mt-1 font-semibold">
                    {formatMoneyMinor(
                      visibleViewingStatement.total.minor,
                      visibleViewingStatement.total.currency,
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Pago</dt>
                  <dd className="mt-1 font-semibold">
                    {formatMoneyMinor(
                      visibleViewingStatement.paid.minor,
                      visibleViewingStatement.paid.currency,
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Em aberto</dt>
                  <dd className="mt-1 font-semibold">
                    {formatMoneyMinor(
                      visibleViewingStatement.openAmount.minor,
                      visibleViewingStatement.openAmount.currency,
                    )}
                  </dd>
                </div>
              </dl>
              {loadingStatementItems ? (
                <p role="status" className="text-sm text-muted-foreground">
                  Carregando composição…
                </p>
              ) : statementItems.length === 0 ? (
                <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                  Esta fatura ainda não possui compras nem pagamentos.
                </p>
              ) : (
                <ul className="max-h-72 divide-y overflow-y-auto">
                  {statementItems.map((item) => {
                    const canceled = item.state === "canceled";
                    const kindLabel = item.type === "payment" ? "Pagamento" : "Compra";
                    return (
                      <li
                        key={item.id}
                        className="flex items-start justify-between gap-3 py-3 first:pt-0 last:pb-0"
                      >
                        <div className="min-w-0">
                          <p className="truncate font-medium">
                            {item.description ||
                              (item.type === "payment" ? "Pagamento de fatura" : "Compra")}
                          </p>
                          <p className="text-sm text-muted-foreground">
                            {kindLabel}
                            {canceled ? " cancelada" : ""} · {item.occurredOn}
                          </p>
                        </div>
                        <span
                          className={
                            canceled
                              ? "shrink-0 text-sm text-muted-foreground line-through"
                              : "shrink-0 font-semibold"
                          }
                        >
                          {statementItemAmountPrefix(item)}
                          {formatMoneyMinor(item.amount.minor, item.amount.currency)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
              {statementItemsHasMore ? (
                <Button
                  type="button"
                  variant="outline"
                  className="self-start"
                  disabled={loadingMoreStatementItems || loadingStatementItems}
                  onClick={() => {
                    if (statementItemsNextCursor && viewingStatementId) {
                      void loadStatementItems(viewingStatementId, statementItemsNextCursor, true);
                    }
                  }}
                >
                  {loadingMoreStatementItems ? "Carregando mais…" : "Carregar mais itens"}
                </Button>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Fechar</DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={visibleEditingCard !== null}
        onOpenChange={(open) => {
          if (!open && !savingCardEdit) setEditingCard(null);
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Editar cartão</DialogTitle>
            <DialogDescription>
              A nova configuração vale para ciclos futuros. Faturas já fechadas preservam suas datas
              e valores.
            </DialogDescription>
          </DialogHeader>
          <form className="grid gap-4" onSubmit={handleCardEditSubmit}>
            <Field>
              <FieldLabel htmlFor="edit-card-name">Nome do cartão</FieldLabel>
              <Input
                id="edit-card-name"
                value={cardEditName}
                onChange={(event) => setCardEditName(event.target.value)}
                required
                disabled={savingCardEdit}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field>
                <FieldLabel htmlFor="edit-card-closing">Fecha dia</FieldLabel>
                <Input
                  id="edit-card-closing"
                  type="number"
                  min={1}
                  max={31}
                  value={cardEditClosingDay}
                  onChange={(event) => setCardEditClosingDay(event.target.value)}
                  required
                  disabled={savingCardEdit}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="edit-card-due">Vence dia</FieldLabel>
                <Input
                  id="edit-card-due"
                  type="number"
                  min={1}
                  max={31}
                  value={cardEditDueDay}
                  onChange={(event) => setCardEditDueDay(event.target.value)}
                  required
                  disabled={savingCardEdit}
                />
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="edit-card-holder">Titular (opcional)</FieldLabel>
              <Input
                id="edit-card-holder"
                value={cardEditHolder}
                onChange={(event) => setCardEditHolder(event.target.value)}
                disabled={savingCardEdit}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="edit-card-last-four">Últimos quatro dígitos</FieldLabel>
              <Input
                id="edit-card-last-four"
                inputMode="numeric"
                maxLength={4}
                value={cardEditLastFour}
                onChange={(event) => setCardEditLastFour(event.target.value.replace(/\D/g, ""))}
                disabled={savingCardEdit}
              />
            </Field>
            <MoneyInput
              id="edit-card-limit"
              value={cardEditLimit}
              onChange={setCardEditLimit}
              label="Limite (opcional)"
              currency={currency}
              disabled={savingCardEdit}
            />
            <DialogFooter>
              <DialogClose
                render={<Button type="button" variant="outline" />}
                disabled={savingCardEdit}
              >
                Cancelar
              </DialogClose>
              <Button type="submit" disabled={savingCardEdit}>
                {savingCardEdit ? "Salvando…" : "Salvar alterações"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={visiblePendingCardArchive !== null}
        onOpenChange={(open) => {
          if (!open && archivingCardId === null) setPendingCardArchive(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Arquivar cartão?</DialogTitle>
            <DialogDescription>
              O cartão deixará de aceitar novas compras, mas suas faturas e pagamentos continuarão
              no histórico.
            </DialogDescription>
          </DialogHeader>
          {visiblePendingCardArchive ? (
            <p className="rounded-lg bg-muted/50 p-3 text-sm">
              O arquivamento só é permitido quando não há saldo em aberto nem fatura pendente para
              este cartão.
            </p>
          ) : null}
          <DialogFooter>
            <DialogClose
              render={<Button type="button" variant="outline" />}
              disabled={archivingCardId !== null}
            >
              Cancelar
            </DialogClose>
            <Button
              type="button"
              onClick={() => void handleCardArchive()}
              disabled={archivingCardId !== null}
            >
              {archivingCardId ? "Arquivando…" : "Arquivar cartão"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={visiblePendingStatementAction !== null}
        onOpenChange={(open) => {
          if (!open && busyStatementId === null) setPendingStatementAction(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {visiblePendingStatementAction?.type === "reopen"
                ? "Reabrir fatura?"
                : "Fechar fatura?"}
            </DialogTitle>
            <DialogDescription>
              {visiblePendingStatementAction?.type === "reopen"
                ? "Esta fatura voltará a aceitar lançamentos. A reabertura é bloqueada quando já existem pagamentos."
                : "O período e o total ficam congelados. Novas compras serão direcionadas para o próximo ciclo."}
            </DialogDescription>
          </DialogHeader>
          {visiblePendingStatementAction ? (
            <p className="rounded-lg bg-muted/50 p-3 text-sm">
              Fatura com vencimento em {visiblePendingStatementAction.statement.dueOn} · valor em
              aberto{" "}
              <strong>
                {formatMoneyMinor(
                  visiblePendingStatementAction.statement.openAmount.minor,
                  visiblePendingStatementAction.statement.openAmount.currency,
                )}
              </strong>
            </p>
          ) : null}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />} disabled={busyStatementId !== null}>
              Cancelar
            </DialogClose>
            <Button
              disabled={busyStatementId !== null}
              onClick={() => {
                if (visiblePendingStatementAction) {
                  void runStatementAction(
                    visiblePendingStatementAction.type,
                    visiblePendingStatementAction.statement,
                  );
                }
              }}
            >
              {busyStatementId
                ? "Salvando…"
                : visiblePendingStatementAction?.type === "reopen"
                  ? "Reabrir fatura"
                  : "Fechar fatura"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function FinancesPage() {
  const { workspaceId, role, fixtureMode, timeZone, currency } = useAuthenticatedWorkspace();
  return (
    <FinanceDashboard
      workspaceId={workspaceId}
      role={role}
      fixtureMode={fixtureMode}
      timeZone={timeZone}
      currency={currency}
    />
  );
}
