# Ledger Logic

Payroll assistant for a Junior HR Assistant. The browser talks to a Next.js app. That app calls a separate agent service, which runs a LangChain tool-calling loop over the employee and salary-band tables.

## Run

```bash
npm install
npm run dev
```

Open http://127.0.0.1:3000. The agent listens on http://127.0.0.1:4001.

The default model is the stub in `apps/agent/.env.local` (`LLM_PROVIDER=stub`), so a trial does not call a paid API. To use OpenAI, set `LLM_PROVIDER=openai` and `OPENAI_API_KEY` in that file. Model calls go through one service that retries transient failures with exponential backoff.

## Tests

```bash
npm test
```

The acceptance suite boots the agent and checks the success criteria, compensation refusals, a few questions outside that list, the step limit, model retry, and the web route that forwards questions to the agent.

## Scaling the agent

The agent keeps no session. Each request carries the question, and the response includes `instanceId` (the process id, or `AGENT_INSTANCE`). Run more copies and point `AGENT_SERVICE_URL` at a load balancer. The Next.js app does not change. The page shows which copy produced each answer.
