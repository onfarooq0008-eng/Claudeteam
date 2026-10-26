# Team Agent

A web app where you chat with a **main AI** that can use tools (create and edit files, run commands, fetch web pages) and **delegate work to other AI accounts** you add, like a small team. Works with any OpenAI-compatible API (OpenRouter, NVIDIA NIM, Groq, Together, DeepSeek, Mistral, Gemini, Ollama, ...) and Anthropic API keys.

## Using it
1. Open the app, tap **☰ Team**, and add accounts: preset or base URL, model name, API key, a name and an optional role (e.g. "writes code", "reviews and tests").
2. The first account is your **main AI**. Tap **Make main** on any account to change it.
3. Chat with the main AI. It works with its tools and uses `delegate_task` to send jobs to teammates, checks their reports, and tells you the result. Teammate reports and every tool call show in the chat.
4. The **Files** panel is the shared workspace: open, edit, save, download, create and delete files. Agents and you see the same files.

## What agents can do
`list_files`, `read_file`, `write_file`, `append_file`, `replace_in_file`, `move_file`, `delete_file`, `fetch_url`, `run_command` (shell), and for the main AI `delegate_task`. File tools cannot leave the workspace folder.

- If a model does not support function calling, the app retries it as plain chat; or tick **Disable tools** when adding it.
- Shell commands run as the app's OS user with the app password and API keys removed from their environment. The shell is **not a hard sandbox**. Set `ALLOW_SHELL=0` to turn it off.
- Tip: use a capable model as main AI (good at tool calling). Cheaper or free models make fine teammates.

## Run locally (Node 18+, no npm packages)
```bash
APP_PASSWORD='choose-a-strong-password' npm start
```
Open http://127.0.0.1:3000.

## Deploy on Koyeb
1. Push this folder to a GitHub repo.
2. In Koyeb: **Create Service → GitHub**, pick the repo, builder **Dockerfile**.
3. Exposed port **8000** (HTTP), health check path `/healthz`.
4. Environment variables (use **Secrets**): `APP_PASSWORD` (required, the app will not start without it), plus provider keys such as `OPENROUTER_KEY`, `NVIDIA_KEY`, which you reference in an account's "env var name" field.
5. Deploy, open your Koyeb URL, log in.

### Persistence
Accounts, chat history and workspace files live in `/app/data`. Koyeb wipes the disk on each redeploy unless you attach a **Volume** at `/app/data` (if your plan supports it). The container fixes volume permissions on start. Without a volume, use `ACCOUNTS_JSON` to recreate accounts on every boot (put it on one line):
```json
[
  {"name":"Boss","type":"openai","baseUrl":"https://openrouter.ai/api/v1","model":"your-model","keyEnv":"OPENROUTER_KEY","main":true},
  {"name":"Coder","type":"openai","baseUrl":"https://integrate.api.nvidia.com/v1","model":"your-model","keyEnv":"NVIDIA_KEY","role":"writes code"},
  {"name":"Reviewer","type":"anthropic","model":"your-model","keyEnv":"ANTHROPIC_KEY","role":"reviews and tests"}
]
```
Check each provider's docs for current model names. Download files you want to keep, or use a volume.

## Docker locally
```bash
docker build -t team-agent .
docker run -p 8000:8000 -e APP_PASSWORD=secret -v team-agent-data:/app/data team-agent
```

## Environment variables
`APP_PASSWORD`, `PORT`, `HOST`, `DATA_DIR`, `WORKSPACE`, `ALLOW_SHELL` (`0` disables shell), `ACCOUNTS_JSON`

## Security notes
- Keys entered in the UI are saved in `data/state.json` (owner-only permissions) and never sent back to the browser. Prefer env-var keys on shared hosts.
- Agents can run code and edit files on the server, so keep the app behind `APP_PASSWORD` and HTTPS.
- Every agent step uses your API credit, so watch usage when delegating big jobs.
