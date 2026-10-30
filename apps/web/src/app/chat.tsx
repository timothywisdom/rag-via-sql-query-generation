"use client";

import { useEffect, useState } from "react";
import { CALLER_HEADER, CALLER_ROLES, type CallerRole } from "../roles";
import { AnswerText } from "./answer";
import { readSse } from "./sse";

export type ServiceHealth = {
  ok: true;
  instanceId: string;
  provider: string;
  asOf: string;
};

type TraceEvent = {
  toolCallId: string;
  tool: string;
  args: unknown;
  output: unknown;
  sql?: string;
};

type AnswerPayload = {
  status: "ok" | "refused" | "error";
  answer: string | null;
  error?: string;
  steps?: number;
  llmAttempts?: number;
  durationMs?: number;
  forcedGenerate?: boolean;
  instanceId?: string;
  provider?: string;
  trace?: TraceEvent[];
  caller?: CallerRole;
  evaluation?: { groundedness: number; passed: boolean };
};

type AnswerPhase = "reason" | "tools" | "generate" | "evaluate";

type Turn = {
  id: string;
  role: "user" | "assistant";
  text: string;
  payload?: AnswerPayload;
  phase?: AnswerPhase;
};

const PHASE_LABEL: Record<AnswerPhase, string> = {
  reason: "Choosing a lookup…",
  tools: "Looking up the ledger…",
  generate: "Writing the answer…",
  evaluate: "Checking the answer…",
};

type MenuModel = { id: string; label: string; source?: "stub" | "gemini" | "ollama" | "cursor" };

function noteForModel(model: MenuModel | undefined): string {
  const source = model?.source ?? sourceFromId(model?.id);
  if (source === "stub") return "Local mock. No model API call.";
  if (source === "gemini") {
    return "Uses your Gemini API key through LangChain. Free-tier prompts may be used to improve Google's products.";
  }
  if (source === "ollama") return "Runs on your local Ollama server. Tool calls use the same reasoning loop.";
  return "Each reasoning step runs this Cursor model and uses your API key.";
}

function sourceFromId(id: string | undefined): NonNullable<MenuModel["source"]> {
  if (!id || id === "stub") return "stub";
  if (id.startsWith("gemini-")) return "gemini";
  if (id.includes(":")) return "ollama";
  return "cursor";
}

function isPhase(value: unknown): value is AnswerPhase {
  return value === "reason" || value === "tools" || value === "generate" || value === "evaluate";
}

function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

const ROLE_NOTES: Record<CallerRole, string> = {
  junior_hr_assistant:
    "Office, tenure, headcount, and non-executive pay are available. Executive salary and expenses are refused.",
  staff: "Office, tenure, and headcount are available. Compensation is refused.",
  manager: "Staff pay is available. Manager and executive compensation is refused.",
  executive: "Full compensation access, including executive pay.",
};

const SUGGESTIONS = [
  "Where does Bob Langley work? How long has he been employed?",
  "We are thinking about moving Terry Jeffords from the Brooklyn office to Nunavut. Is his salary sufficient, or will we need to increase it to be more aligned with Nunavut salaries?",
  "What was the total payroll for 2024?",
  "What is Horatio Kane's salary?",
  "What was the total of expenses paid to Nancy Nunchuk in 2023?",
  "How many employees work in Chicago?",
  "What is the average 2025 salary in the Technology department?",
];

export function Chat({ initialHealth }: { initialHealth: ServiceHealth | null }) {
  const [health, setHealth] = useState(initialHealth);
  const [draft, setDraft] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [pending, setPending] = useState(false);
  const [caller, setCaller] = useState<CallerRole>("junior_hr_assistant");
  const [model, setModel] = useState("stub");
  const [models, setModels] = useState<MenuModel[]>([{ id: "stub", label: "Stub", source: "stub" }]);
  const [modelNote, setModelNote] = useState("Local mock. No model API call.");

  useEffect(() => {
    void fetch("/api/models")
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { models?: MenuModel[]; cursor?: string; gemini?: string; ollama?: string } | null) => {
        if (!body?.models?.length) return;
        setModels(body.models);
        if (body.ollama === "unavailable") {
          setModelNote("The Ollama server could not be reached. Stub is still available.");
        } else if (body.cursor === "unavailable") {
          setModelNote("Cursor models could not be loaded. Stub is still available.");
        } else if (body.cursor === "missing_key" && body.gemini === "missing_key" && body.ollama !== "ready") {
          setModelNote("Add GEMINI_API_KEY, CURSOR_API_KEY, or OLLAMA_BASE_URL in apps/agent/.env.local to list live models.");
        }
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (health?.ok) return;
    const timer = setInterval(() => {
      void fetch("/api/health")
        .then((response) => (response.ok ? response.json() : null))
        .then((body: ServiceHealth | null) => {
          if (body?.ok) setHealth(body);
        })
        .catch(() => undefined);
    }, 1500);
    return () => clearInterval(timer);
  }, [health]);

  async function submit(question: string) {
    const query = question.trim();
    if (!query || pending) return;
    setDraft("");
    setPending(true);
    setTurns((current) => [...current, { id: crypto.randomUUID(), role: "user", text: query }]);
    const assistantId = crypto.randomUUID();
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          [CALLER_HEADER]: caller,
          "x-model": model,
        },
        body: JSON.stringify({ query }),
      });
      const type = response.headers.get("content-type") ?? "";
      if (!type.includes("text/event-stream")) {
        const payload = (await response.json()) as AnswerPayload;
        const text = response.ok
          ? payload.answer ?? payload.error ?? "The agent did not return an answer."
          : payload.error ?? "The request failed.";
        setTurns((current) => [
          ...current,
          {
            id: assistantId,
            role: "assistant",
            text,
            payload: response.ok ? payload : { ...payload, status: "error", answer: null, error: text },
          },
        ]);
        return;
      }
      setTurns((current) => [...current, { id: assistantId, role: "assistant", text: "", phase: "reason" }]);
      let finished = false;
      await readSse(response, (message) => {
        const data = message.data;
        if (!data || typeof data !== "object") return;
        const record = data as { text?: unknown; phase?: unknown; payload?: AnswerPayload; error?: unknown };
        setTurns((current) =>
          current.map((turn) => {
            if (turn.id !== assistantId) return turn;
            if (message.event === "token" && typeof record.text === "string") {
              return { ...turn, text: turn.text + record.text };
            }
            if (message.event === "replace") return { ...turn, text: "" };
            if (message.event === "status" && isPhase(record.phase)) return { ...turn, phase: record.phase };
            if (message.event === "error") {
              finished = true;
              const error = typeof record.error === "string" ? record.error : "The agent failed before it could answer.";
              return { ...turn, text: error, phase: undefined, payload: { status: "error", answer: null, error } };
            }
            if (message.event === "done" && record.payload) {
              finished = true;
              const payload = record.payload;
              const text =
                payload.status === "error"
                  ? payload.error ?? "The agent failed before it could answer."
                  : payload.answer ?? turn.text;
              return { ...turn, text, payload, phase: undefined };
            }
            return turn;
          }),
        );
      });
      if (!finished) {
        setTurns((current) =>
          current.map((turn) =>
            turn.id === assistantId && !turn.payload
              ? {
                  ...turn,
                  text: "The web server could not reach the agent service.",
                  phase: undefined,
                  payload: {
                    status: "error",
                    answer: null,
                    error: "The web server could not reach the agent service.",
                  },
                }
              : turn,
          ),
        );
      }
    } catch {
      const error = "The web server could not reach the agent service.";
      setTurns((current) => {
        const failed = {
          id: assistantId,
          role: "assistant" as const,
          text: error,
          payload: { status: "error" as const, answer: null, error },
        };
        if (current.some((turn) => turn.id === assistantId)) {
          return current.map((turn) => (turn.id === assistantId ? failed : turn));
        }
        return [...current, failed];
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="app">
      <header className="masthead">
        <div>
          <p className="kicker">PennyWise LLP</p>
          <h1>Ledger Logic</h1>
        </div>
        <div className="role-picker">
          <label htmlFor="model">Model</label>
          <select
            id="model"
            value={model}
            disabled={pending}
            onChange={(event) => {
              const next = event.target.value;
              setModel(next);
              setModelNote(noteForModel(models.find((item) => item.id === next)));
            }}
          >
            {models.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
          <p>{modelNote}</p>
          <label htmlFor="caller-role">Role</label>
          <select
            id="caller-role"
            value={caller}
            disabled={pending}
            onChange={(event) => setCaller(event.target.value as CallerRole)}
          >
            {CALLER_ROLES.map((role) => (
              <option key={role.value} value={role.value}>
                {role.label}
              </option>
            ))}
          </select>
          <p>{ROLE_NOTES[caller]} Each question is answered on its own.</p>
        </div>
      </header>
      {!health ? <p className="banner">The agent service is not connected yet.</p> : null}
      <div className="shell">
        <aside className="rail">
          <h2>Ask the ledger</h2>
          <p>
            {health
              ? `Connected to ${health.instanceId}. Tenure is measured as of ${health.asOf}.`
              : "Start the agent service, then ask again."}
          </p>
          <div className="suggestions">
            {SUGGESTIONS.map((question) => (
              <button key={question} type="button" disabled={pending} onClick={() => void submit(question)}>
                {question}
              </button>
            ))}
          </div>
        </aside>
        <section className="conversation" aria-busy={pending}>
          <div className="transcript" aria-live="polite">
            {turns.length === 0 ? (
              <p className="status">Answers come from the agent service, which can be run as more than one copy.</p>
            ) : null}
            {turns.map((turn) => (
              <article key={turn.id} className={`bubble ${turn.role} ${turn.payload?.status ?? ""}`}>
                {turn.role === "assistant" && turn.text && turn.payload?.status !== "error" ? (
                  <AnswerText text={turn.text} />
                ) : (
                  turn.text
                )}
                {turn.phase && (turn.text.length === 0 || turn.phase === "evaluate") ? (
                  <p className="status">{PHASE_LABEL[turn.phase]}</p>
                ) : null}
                {turn.payload && turn.payload.status !== "error" ? (
                  <div className="meta">
                    Served by {turn.payload.instanceId ?? "the agent"} as {turn.payload.caller ?? caller} with{" "}
                    {turn.payload.provider ?? model} in{" "}
                    {turn.payload.durationMs ?? 0} ms
                    {" · "}
                    {countLabel(turn.payload.steps ?? 0, "reasoning step", "reasoning steps")}
                    {" · "}
                    {countLabel(turn.payload.llmAttempts ?? 0, "model call", "model calls")}
                    {turn.payload.evaluation
                      ? ` · groundedness ${Math.round(turn.payload.evaluation.groundedness * 100)}%`
                      : ""}
                  </div>
                ) : null}
                {turn.payload?.trace && turn.payload.trace.length > 0 ? (
                  <details className="trace">
                    <summary>Reasoning trace</summary>
                    <pre>{JSON.stringify(turn.payload.trace, null, 2)}</pre>
                  </details>
                ) : null}
              </article>
            ))}
          </div>
          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault();
              void submit(draft);
            }}
          >
            <textarea
              aria-label="Payroll question"
              value={draft}
              placeholder="Ask about an employee, an office, a total, or a salary band."
              onChange={(event) => setDraft(event.target.value)}
            />
            <button className="send" type="submit" disabled={pending || draft.trim().length === 0}>
              {pending ? "Asking…" : "Ask"}
            </button>
          </form>
        </section>
      </div>
    </main>
  );
}
