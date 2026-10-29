import { Chat, type ServiceHealth } from "./chat";

export const dynamic = "force-dynamic";

async function loadHealth(): Promise<ServiceHealth | null> {
  const base = process.env.AGENT_SERVICE_URL;
  if (!base) return null;
  try {
    const response = await fetch(new URL("/health", base), { cache: "no-store" });
    if (!response.ok) return null;
    const body = (await response.json()) as ServiceHealth;
    if (!body.ok) return null;
    return body;
  } catch {
    return null;
  }
}

export default async function Page() {
  const health = await loadHealth();
  return <Chat initialHealth={health} />;
}
