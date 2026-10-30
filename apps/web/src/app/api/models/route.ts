export async function GET(): Promise<Response> {
  const agentUrl = process.env.AGENT_SERVICE_URL;
  if (!agentUrl) {
    return Response.json({
      models: [{ id: "stub", label: "Stub", source: "stub" }],
      cursor: "unavailable",
      gemini: "missing_key",
      ollama: "unset",
    });
  }
  try {
    const upstream = await fetch(new URL("/models", agentUrl), {
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    const payload = (await upstream.json()) as unknown;
    return Response.json(payload, { status: upstream.status });
  } catch {
    return Response.json({
      models: [{ id: "stub", label: "Stub", source: "stub" }],
      cursor: "unavailable",
      gemini: "missing_key",
      ollama: "unset",
    });
  }
}
