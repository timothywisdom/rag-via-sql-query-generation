export async function POST(request: Request): Promise<Response> {
  let body: { query?: unknown };
  try {
    body = (await request.json()) as { query?: unknown };
  } catch {
    return Response.json({ status: "error", error: "Request body must be JSON." }, { status: 400 });
  }

  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query) {
    return Response.json({ status: "error", error: "Query is required." }, { status: 400 });
  }

  const agentUrl = process.env.AGENT_SERVICE_URL;
  if (!agentUrl) {
    return Response.json({ status: "error", error: "AGENT_SERVICE_URL is not configured." }, { status: 500 });
  }

  try {
    const upstream = await fetch(new URL("/answer", agentUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, caller: "junior_hr_assistant" }),
      signal: AbortSignal.timeout(30_000),
    });
    const payload = (await upstream.json()) as unknown;
    return Response.json(payload, { status: upstream.status });
  } catch {
    return Response.json({ status: "error", error: "The agent service is unavailable." }, { status: 502 });
  }
}
