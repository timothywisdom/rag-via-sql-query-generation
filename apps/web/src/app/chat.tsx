"use client";

import { useEffect, useState } from "react";

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
};

type Turn = {
  id: string;
  role: "user" | "assistant";
  text: string;
  payload?: AnswerPayload;
};

function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

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
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query }),
      });
      const payload = (await response.json()) as AnswerPayload;
      const text = response.ok
        ? payload.answer ?? payload.error ?? "The agent did not return an answer."
        : payload.error ?? "The request failed.";
      setTurns((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          text,
          payload: response.ok ? payload : { ...payload, status: "error", answer: null, error: text },
        },
      ]);
    } catch {
      setTurns((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          text: "The web server could not reach the agent service.",
          payload: { status: "error", answer: null, error: "The web server could not reach the agent service." },
        },
      ]);
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
        <p className="caller">
          Signed in as a Junior HR Assistant. Office, tenure, headcount, and non-executive pay are available.
          Executive salary and expenses are refused. Each question is answered on its own.
        </p>
      </header>
      {!health ? <p className="banner">The agent service is not connected yet.</p> : null}
      <div className="shell">
        <aside className="rail">
          <h2>Ask the ledger</h2>
          <p>
            {health
              ? `Connected to ${health.instanceId}. Model: ${health.provider}. Tenure is measured as of ${health.asOf}.`
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
                {turn.text}
                {turn.payload && turn.payload.status !== "error" ? (
                  <div className="meta">
                    Served by {turn.payload.instanceId ?? "the agent"} in {turn.payload.durationMs ?? 0} ms
                    {" · "}
                    {countLabel(turn.payload.steps ?? 0, "reasoning step", "reasoning steps")}
                    {" · "}
                    {countLabel(turn.payload.llmAttempts ?? 0, "model call", "model calls")}
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
