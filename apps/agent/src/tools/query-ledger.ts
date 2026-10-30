import { tool } from "langchain";
import type { CallerRole } from "../ledger/callers";
import { ledgerQuerySchema, QUERY_TOOL_DESCRIPTION } from "../ledger/catalog";
import type { LedgerDatabase } from "../ledger/database";
import { runLedgerQuery } from "../ledger/query";

export function createLedgerTool(db: LedgerDatabase, asOf: string, caller: CallerRole) {
  return tool(
    async (input) => JSON.stringify(runLedgerQuery(db, input, asOf, caller)),
    {
      name: "query_ledger",
      description: QUERY_TOOL_DESCRIPTION,
      schema: ledgerQuerySchema,
    },
  );
}
