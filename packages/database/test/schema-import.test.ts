import assert from "node:assert/strict";
import { test } from "node:test";

import {
  financeTransaction,
  importJob,
  importJobLine,
  workspacePreference,
} from "../src/schema.js";

test("imports the preference schema after its initial-balance transaction dependency", () => {
  assert.ok(workspacePreference.workspaceId);
  assert.ok(workspacePreference.initialBalanceTransactionId);
  assert.ok(financeTransaction.id);
  assert.ok(importJob.id);
  assert.ok(importJobLine.jobId);
});
