import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { configFromEnv, defaultDataDir } from "../../agent/src/config.ts";
import { judgeAnswer } from "../../agent/src/eval/judge.ts";
import {
  scoreAccuracy,
  scoreGroundedness,
  toolContext,
  type GoldenCase,
} from "../../agent/src/eval/score.ts";
import { isCallerRole } from "../../agent/src/ledger/callers.ts";
import { loadLedger } from "../../agent/src/ledger/database.ts";
import { createLlmService, llmForModel } from "../../agent/src/llm/index.ts";
import { runLedgerAgent } from "../../agent/src/agent/loop.ts";

function loadEnvFile(filePath: string): void {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(fileURLToPath(new URL("../../agent/.env.local", import.meta.url)));

const cases = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../golden.json", import.meta.url)),
    "utf8",
  ),
) as GoldenCase[];

const config = configFromEnv();
const db = loadLedger(config.dataDir || defaultDataDir());
const fallback = createLlmService(config);
const modelId = process.env.EVAL_MODEL?.trim() || "stub";
const llm = await llmForModel(config, modelId, fallback);

const rows: Array<Record<string, string | number>> = [];
let failed = 0;

for (const item of cases) {
  if (!isCallerRole(item.caller))
    throw new Error(`${item.id} has an unknown caller.`);
  const result = await runLedgerAgent(db, llm, config, item.query, item.caller);
  const context = toolContext(result.trace);
  const refused =
    result.trace.length > 0 &&
    result.trace.every((event) => event.output.status !== "ok");
  const scored =
    llm.name === "stub"
      ? ruleScore(result.answer, result.status, item, context, refused)
      : await judgeAnswer(
          llm,
          item,
          result.answer ?? "",
          result.status,
          context,
        );
  if (scored.accuracy < 1 || scored.groundedness < 1) failed += 1;
  rows.push({
    id: item.id,
    accuracy: scored.accuracy,
    groundedness: scored.groundedness,
    status: result.status,
    failures: scored.failures.join(" ") || "",
  });
}

db.close();

console.table(rows);
const average = (key: "accuracy" | "groundedness") =>
  (rows.reduce((sum, row) => sum + Number(row[key]), 0) / rows.length).toFixed(
    2,
  );
console.log(`Model: ${llm.name}`);
console.log(`Scorer: ${llm.name === "stub" ? "rules" : "llm judge"}`);
console.log(`Accuracy:     ${average("accuracy")}`);
console.log(`Groundedness: ${average("groundedness")}`);

function ruleScore(
  answer: string | null,
  status: string,
  item: GoldenCase,
  context: string,
  refused: boolean,
) {
  const accuracy = scoreAccuracy(answer, status, item);
  const grounded = scoreGroundedness(
    answer ?? "",
    context,
    refused,
    item.query,
  );
  return {
    accuracy: accuracy.accuracy,
    groundedness: grounded.groundedness,
    failures: [...accuracy.failures, ...grounded.failures],
  };
}

if (failed > 0) {
  console.log(`${failed} golden case(s) scored below 1.`);
}

process.exit();
