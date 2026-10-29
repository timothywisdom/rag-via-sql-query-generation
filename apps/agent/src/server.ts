import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { runLedgerAgent, type AgentResponse } from "./agent/loop";
import { configFromEnv, type AppConfig } from "./config";
import { loadLedger, type LedgerDatabase } from "./ledger/database";
import { createLlmService } from "./llm";
import { LlmService } from "./llm/service";

export type RunningServer = {
  url: string;
  port: number;
  instanceId: string;
  close: () => Promise<void>;
};

export async function startServer(config: AppConfig): Promise<RunningServer> {
  const db = loadLedger(config.dataDir);
  const llm = createLlmService(config);
  const server = createServer((req, res) => {
    void handle(req, res, db, llm, config);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => resolve());
  });

  const address = server.address() as AddressInfo;
  return {
    url: `http://${config.host}:${address.port}`,
    port: address.port,
    instanceId: config.instanceId,
    close: async () => {
      server.closeIdleConnections?.();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      db.close();
    },
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  db: LedgerDatabase,
  llm: LlmService,
  config: AppConfig,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (req.method === "GET" && url.pathname === "/health") {
    send(res, 200, {
      ok: true,
      instanceId: config.instanceId,
      provider: config.llmProvider,
      asOf: config.asOfDate,
    });
    return;
  }
  if (req.method === "POST" && url.pathname === "/answer") {
    await answer(req, res, db, llm, config);
    return;
  }
  send(res, 404, { status: "error", error: "Not found." });
}

async function answer(
  req: IncomingMessage,
  res: ServerResponse,
  db: LedgerDatabase,
  llm: LlmService,
  config: AppConfig,
): Promise<void> {
  const started = Date.now();
  const requestId = crypto.randomUUID();
  let body: { query?: unknown; caller?: unknown };
  try {
    body = JSON.parse(await readBody(req)) as { query?: unknown; caller?: unknown };
  } catch (error) {
    const tooLarge = error instanceof Error && error.message === "body too large";
    send(res, tooLarge ? 413 : 400, {
      status: "error",
      error: tooLarge ? "Request body is too large." : "Request body must be JSON.",
    });
    return;
  }

  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query) {
    send(res, 400, { status: "error", error: "Query is required." });
    return;
  }
  if (body.caller !== undefined && body.caller !== "junior_hr_assistant") {
    send(res, 400, { status: "error", error: "Only the junior_hr_assistant caller is supported." });
    return;
  }

  try {
    const result = await runLedgerAgent(db, llm, config, query);
    const payload = {
      ...result,
      requestId,
      instanceId: config.instanceId,
      durationMs: Date.now() - started,
    };
    logAnswer(payload, config);
    send(res, 200, payload);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "request_failed",
        requestId,
        message: error instanceof Error ? error.message : "error",
      }),
    );
    send(res, 500, { status: "error", error: "The agent failed before it could answer.", requestId });
  }
}

function logAnswer(payload: AgentResponse & { requestId: string; instanceId: string; durationMs: number }, config: AppConfig): void {
  console.log(
    JSON.stringify({
      event: "answer",
      requestId: payload.requestId,
      instanceId: payload.instanceId,
      provider: config.llmProvider,
      status: payload.status,
      steps: payload.steps,
      llmAttempts: payload.llmAttempts,
      durationMs: payload.durationMs,
      tools: payload.trace.map((event) => ({ tool: event.tool, status: event.output.status })),
    }),
  );
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 20_000) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    connection: "close",
  });
  res.end(payload);
}

export function main(): void {
  startServer(configFromEnv()).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
