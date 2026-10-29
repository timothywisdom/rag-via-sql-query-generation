export async function GET(): Promise<Response> {
  const agentUrl = process.env.AGENT_SERVICE_URL;
  if (!agentUrl) {
    return Response.json({ ok: false, error: "AGENT_SERVICE_URL is not configured." }, { status: 500 });
  }
  try {
    const upstream = await fetch(new URL("/health", agentUrl), {
      cache: "no-store",
      signal: AbortSignal.timeout(3_000),
    });
    const payload = (await upstream.json()) as unknown;
    return Response.json(payload, { status: upstream.status });
  } catch {
    return Response.json({ ok: false, error: "The agent service is unavailable." }, { status: 502 });
  }
}
