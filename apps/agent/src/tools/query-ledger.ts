import { tool } from "langchain";
import { ledgerQuerySchema, QUERY_TOOL_DESCRIPTION } from "../ledger/catalog";
import type { LedgerDatabase } from "../ledger/database";
import { runLedgerQuery } from "../ledger/query";

export function createLedgerTool(db: LedgerDatabase, asOf: string) {
  return tool(
    async (input) => JSON.stringify(runLedgerQuery(db, input, asOf)),
    {
      name: "query_ledger",
      description: QUERY_TOOL_DESCRIPTION,
      schema: ledgerQuerySchema,
    },
  );
}
