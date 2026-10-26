# Claude Team (web UI)

A web app where several AI accounts work together in one group chat, like Claude Code in the browser. Mix Claude Code accounts with any OpenAI-compatible API (OpenRouter, NVIDIA NIM, Groq, Together, DeepSeek, Mistral, Gemini, Ollama, ...) or an Anthropic API key.

## Account types
| Type | Sign-in | Can edit files? |
|---|---|---|
| **Claude Code** | Official login on the server, or a token from `claude setup-token` pasted in the UI | Yes (shared workspace folder) |
| **Custom API (OpenAI-compatible)** | Base URL + model + API key (or the name of an env var holding the key) | No, replies with text and code blocks |
| **Anthropic API** | API key + model | No |

Pick a preset in the UI (OpenAI, OpenRouter, NVIDIA NIM, Groq, ...) or enter any base URL ending in `/v1`. Add as many accounts as you like and name them (e.g. "nvidia 1", "openrouter 2").

Your email and password are never entered in this app. Claude Code accounts use Anthropic's official login or token.

## Run locally (Node 18+, no npm packages)
```bash
APP_PASSWORD='choose-a-strong-password' npm start
```
Open http://127.0.0.1:3000. For Claude Code accounts, run the command shown on the account card once on the server, or paste a token (below).

## Deploy on Koyeb
1. Push this folder to a GitHub repo.
2. In Koyeb: **Create Service → GitHub**, pick the repo, builder **Dockerfile**.
3. Set the exposed port to **8000** (HTTP) and the health check path to `/healthz`.
4. Add environment variables (as **Secrets**):
   - `APP_PASSWORD` (required: the app will not start without it)
   - Optional API keys, e.g. `OPENROUTER_KEY`, `NVIDIA_KEY`, referenced from an account's "env var name" field
   - Optional `ACCOUNTS_JSON` to pre-create accounts on every boot (see below)
5. Deploy, open your Koyeb URL, log in with `APP_PASSWORD`.

### Claude Code accounts on Koyeb
Koyeb has no interactive terminal login, so use a token:
1. On your own computer run `claude setup-token` and sign in with the account.
2. Paste the token into the account's token field in the UI (or store it as a Koyeb secret and put the variable name in `ACCOUNTS_JSON` as `keyEnv`).

### Persistence
Accounts and chat history live in `/app/data`. Koyeb's disk is wiped on each redeploy unless you attach a **Volume** mounted at `/app/data` (if your plan supports it). Without a volume, use `ACCOUNTS_JSON` so accounts come back automatically:
```json
[
  {"name":"Architect","type":"claude","role":"plans and reviews","keyEnv":"CLAUDE_TOKEN_1"},
  {"name":"nvidia 1","type":"openai","baseUrl":"https://integrate.api.nvidia.com/v1","model":"meta/llama-3.1-70b-instruct","keyEnv":"NVIDIA_KEY","role":"writes code"},
  {"name":"claude api","type":"anthropic","model":"claude-sonnet-4-5","keyEnv":"ANTHROPIC_KEY"}
]
```
Put that on one line as the `ACCOUNTS_JSON` value. Check each provider's docs for current model names.

### Size
Claude Code is heavy. A 512 MB instance can run API-only teams comfortably but may struggle with Claude Code accounts; choose a larger instance if you see restarts. Agents run one at a time.

## Docker locally
```bash
docker build -t claude-team .
docker run -p 8000:8000 -e APP_PASSWORD=secret -v claude-team-data:/app/data claude-team
```

## How the team works
You send a task, each account speaks in turn and sees the whole conversation, and an agent writes `DONE: ...` to stop early. **Rounds** sets how many times each account speaks per message. Claude Code agents share one folder (`data/workspace`) which you can browse in the side panel.

## Environment variables
`APP_PASSWORD`, `PORT`, `HOST`, `DATA_DIR`, `WORKSPACE`, `CLAUDE_BIN`, `ACCOUNTS_JSON`

## Security notes
- Keys and tokens entered in the UI are saved in `data/state.json` (owner-only permissions) and are never sent back to the browser. Prefer the env-var option on shared hosts.
- Claude Code agents can edit files in the workspace, so keep the app behind `APP_PASSWORD` and HTTPS.
- Every agent message uses that account's plan limits or API credit, so keep rounds low.
