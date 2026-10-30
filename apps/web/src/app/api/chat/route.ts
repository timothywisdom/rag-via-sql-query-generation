import { CALLER_HEADER, isCallerRole } from "../../../roles";

const MODEL_HEADER = "x-model";

export async function POST(request: Request): Promise<Response> {
  let body: { query?: unknown };
  try {
    body = (await request.json()) as { query?: unknown };
  } catch {
    return Response.json(
      { status: "error", error: "Request body must be JSON." },
      { status: 400 },
    );
  }

  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query) {
    return Response.json(
      { status: "error", error: "Query is required." },
      { status: 400 },
    );
  }

  const caller =
    request.headers.get(CALLER_HEADER)?.trim() || "junior_hr_assistant";
  if (!isCallerRole(caller)) {
    return Response.json(
      { status: "error", error: "Unknown caller role." },
      { status: 400 },
    );
  }
  const model = request.headers.get(MODEL_HEADER)?.trim() || "stub";

  const agentUrl = process.env.AGENT_SERVICE_URL;
  if (!agentUrl) {
    return Response.json(
      { status: "error", error: "AGENT_SERVICE_URL is not configured." },
      { status: 500 },
    );
  }

  console.log(
    JSON.stringify({
      event: "chat",
      model,
      caller,
      query: query.slice(0, 240),
    }),
  );
  try {
    const upstream = await fetch(new URL("/answer", agentUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [CALLER_HEADER]: caller,
        [MODEL_HEADER]: model,
      },
      body: JSON.stringify({ query, caller }),
      signal: AbortSignal.timeout(180000),
    });
    const payload = (await upstream.json()) as unknown;
    console.log(
      JSON.stringify({ event: "chat_done", model, status: upstream.status }),
    );
    return Response.json(payload, { status: upstream.status });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "chat_failed",
        model,
        name: error instanceof Error ? error.name : "error",
      }),
    );
    return Response.json(
      { status: "error", error: "The agent service is unavailable." },
      { status: 502 },
    );
  }
}
