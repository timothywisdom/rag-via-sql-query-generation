# RAG via SQL Query Generation Demo

This is a demo payroll assistant for a Junior HR Assistant. The browser talks to a Next.js app. That app calls a separate agent service. The agent is a LangGraph that hops between reason, tools, and generate over the employee and salary-band tables.

## Run

```bash
npm install
npm run dev
```

Open http://127.0.0.1:3000. The agent listens on http://127.0.0.1:4001.

The default model is the stub, so a trial does not call a paid API. Set `OLLAMA_BASE_URL` to a reachable Ollama server, such as `http://192.168.50.252:11434`, to list its tool-calling models. Those choices use LangChain's OpenAI-compatible client against that server and the same tool-calling loop. Set `GEMINI_API_KEY` in `apps/agent/.env.local` to add Gemini 3.8 Flash to the model menu. That choice goes through LangChain's Gemini chat client and the same tool-calling loop. A Cursor key in `CURSOR_API_KEY` lists Cursor models; each of those reasoning steps is a tool-free Cursor agent run and uses your plan. `LLM_PROVIDER=openai` with `OPENAI_API_KEY` is still available as the process-wide provider. Model calls go through one service that retries transient failures with exponential backoff.

## Tests

```bash
npm test
```

The acceptance suite boots the agent and checks the success criteria, compensation refusals, a few questions outside that list, the step limit, model retry, and the web route that forwards questions to the agent.

## Evaluation

Offline scores run the golden questions in `apps/eval/golden.json` through the same agent and LLM service:

```bash
npm run eval
```

The stub run scores with rules: required phrases, forbidden amounts, and any figure or mid-sentence name that is in neither the question nor the tool results. A year copied from the question is allowed. Set `EVAL_MODEL` to a menu model id, such as `qwen-3.8-27b:256k`, and that same model judges the answers. The judge treats a paraphrase as the required fact, ignores apologies and escalation advice, and still rejects an amount or place the tool results do not contain. If that reply is not a score, the model is asked again up to `MAX_JUDGE_RETRY_ATTEMPTS` (default 3), and the next prompt includes the error. The run exits with an error if either score is below 1.

`npm run dev` leaves the live check off. `npm run dev:online` turns it on for that process. `ONLINE_EVAL=1` scores each live answer with that same judge and waits for the finished answer. The generate step streams only while that check is off. The stub still uses the figure-and-name rules, because it cannot return a score. A failing answer is sent back to generate, or to reason when no lookup ran, with the judge's reasons. `ONLINE_EVAL_MAX_RETRIES` is how many revisions to attempt (0 to 2, default 1). Leave the check off when that extra model call is not worth the wait.

## Scaling the agent

The agent keeps no session. Each request carries the question, and the response includes `instanceId` (the process id, or `AGENT_INSTANCE`). Run more copies and point `AGENT_SERVICE_URL` at a load balancer. The Next.js app does not change. The page shows which copy produced each answer.
