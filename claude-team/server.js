// Claude Team Web UI: a group chat where several AI accounts work as a team. Zero npm dependencies.
// Account types:
//   claude    - Claude Code profile. Signed in via the OFFICIAL login (profile folder) or a
//               long-lived token from `claude setup-token` (works on headless hosts like Koyeb).
//   openai    - any OpenAI-compatible API (OpenAI, OpenRouter, NVIDIA NIM, Groq, Together, DeepSeek, Ollama...)
//   anthropic - Anthropic Messages API with an API key
const http = require('http');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const PROFILES = path.join(DATA, 'profiles');
const WORKSPACE = process.env.WORKSPACE || path.join(DATA, 'workspace');
const STATE_FILE = path.join(DATA, 'state.json');
const PUBLIC = path.join(__dirname, 'public');

const isLoopback = ['127.0.0.1', 'localhost', '::1'].includes(HOST);
if (!isLoopback && !APP_PASSWORD) {
  console.error('Refusing to listen on a public address without APP_PASSWORD. Set APP_PASSWORD and retry.');
  process.exit(1);
}
fs.mkdirSync(PROFILES, { recursive: true });
fs.mkdirSync(WORKSPACE, { recursive: true });

let state = { accounts: [], messages: [] };
try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (_) {}
state.accounts = (state.accounts || []).map(a => ({ type: 'claude', ...a })); // upgrade old state
const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'agent';
const TYPES = ['claude', 'openai', 'anthropic'];

// Optional seeding for hosts with no persistent disk (e.g. Koyeb without a volume):
// ACCOUNTS_JSON='[{"name":"Coder","type":"openai","baseUrl":"https://openrouter.ai/api/v1","model":"...","keyEnv":"OPENROUTER_KEY"}]'
try {
  for (const s of JSON.parse(process.env.ACCOUNTS_JSON || '[]')) {
    const id = slug(s.name || '');
    if (!s.name || !TYPES.includes(s.type || 'claude') || state.accounts.some(a => a.id === id)) continue;
    state.accounts.push({ id, type: 'claude', role: '', ...s });
    fs.mkdirSync(path.join(PROFILES, id), { recursive: true });
  }
} catch (e) { console.error('ACCOUNTS_JSON ignored:', e.message); }

const sessions = new Set();
const cookieOf = (req) => (req.headers.cookie || '').split(';').map(s => s.trim())
  .find(s => s.startsWith('sid='))?.slice(4);
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((resolve) => {
  let b = ''; req.on('data', d => { b += d; if (b.length > 1e6) req.destroy(); });
  req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (_) { resolve({}); } });
});

const profileDir = (id) => path.join(PROFILES, id);
const apiKeyOf = (a) => a.apiKey || (a.keyEnv ? process.env[a.keyEnv] : '') || '';
const hasCredential = (a) => a.type === 'claude' ? !!(a.oauthToken || (a.keyEnv && process.env[a.keyEnv])) : !!apiKeyOf(a);
const publicAccount = (a) => ({
  id: a.id, name: a.name, role: a.role, type: a.type, model: a.model || '', baseUrl: a.baseUrl || '',
  keyEnv: a.keyEnv || '', hasKey: hasCredential(a), dir: a.type === 'claude' ? profileDir(a.id) : '',
});
const safeId = (s) => /^[a-z0-9-]{1,40}$/.test(s);
const cleanUrl = (u) => String(u || '').trim().replace(/\/+$/, '');

// ---- agent backends ----
function runClaude(account, prompt, timeoutMs) {
  return new Promise((resolve) => {
    const args = ['-p', prompt, '--output-format', 'json', '--permission-mode', 'acceptEdits'];
    const env = { ...process.env, CLAUDE_CONFIG_DIR: profileDir(account.id) };
    const tok = account.oauthToken || (account.keyEnv ? process.env[account.keyEnv] : '');
    if (tok) env.CLAUDE_CODE_OAUTH_TOKEN = tok;
    const child = spawn(CLAUDE_BIN, args, { cwd: WORKSPACE, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', d => (out += d));
    child.stderr.on('data', d => (err += d));
    child.on('error', e => { clearTimeout(timer); resolve({ ok: false, text: `Could not start "${CLAUDE_BIN}": ${e.message}. Is Claude Code installed?` }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(out);
        if (j.is_error) return resolve({ ok: false, text: String(j.result || 'Error') });
        return resolve({ ok: true, text: String(j.result || '').trim() });
      } catch (_) {
        resolve({ ok: false, text: (err || out || `exited with code ${code}`).trim().slice(0, 2000) });
      }
    });
  });
}

async function postJson(url, headers, body, timeoutMs) {
  const r = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
  });
  const raw = await r.text();
  let j = {}; try { j = JSON.parse(raw); } catch (_) {}
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${(j.error && (j.error.message || j.error)) || raw}`.slice(0, 600));
  return j;
}

async function runApi(account, system, prompt, timeoutMs) {
  try {
    const key = apiKeyOf(account);
    if (!key) return { ok: false, text: 'No API key set for this account.' };
    if (!account.model) return { ok: false, text: 'No model set for this account.' };
    if (account.type === 'anthropic') {
      const base = cleanUrl(account.baseUrl) || 'https://api.anthropic.com';
      const j = await postJson(`${base}/v1/messages`, { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        { model: account.model, max_tokens: 4096, system, messages: [{ role: 'user', content: prompt }] }, timeoutMs);
      const text = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      return { ok: true, text };
    }
    const base = cleanUrl(account.baseUrl) || 'https://api.openai.com/v1';
    const j = await postJson(`${base}/chat/completions`, { Authorization: `Bearer ${key}` },
      { model: account.model, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }, timeoutMs);
    return { ok: true, text: String(j.choices?.[0]?.message?.content || '').trim() };
  } catch (e) {
    return { ok: false, text: String(e.message || e) };
  }
}

function runAgent(account, system, prompt, { timeoutMs = 10 * 60 * 1000 } = {}) {
  if (account.type === 'claude') return runClaude(account, `${system}\n\n${prompt}`, timeoutMs);
  return runApi(account, system, prompt, Math.min(timeoutMs, 5 * 60 * 1000));
}

const transcript = () => state.messages.map(m => `[${m.from}]: ${m.text}`).join('\n\n').slice(-30000);

function systemFor(acct) {
  const names = state.accounts.map(a => a.name).join(', ');
  const canFiles = acct.type === 'claude';
  return `You are "${acct.name}", one member of a team of AI agents (${names}) working in a shared group chat with a human.
${acct.role ? `Your role: ${acct.role}\n` : ''}${canFiles
    ? 'The shared working folder is your current directory; you may read and write files there.'
    : 'You cannot access files. Put any code or file contents directly in your message in fenced code blocks so a teammate with file access can save them.'}
Rules: build on what teammates already said, don't repeat them, hand off clearly, and write "DONE: <summary>" when the human's request is fully complete.`;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const p = path.resolve(PUBLIC, rel);
  if (!p.startsWith(PUBLIC + path.sep)) return json(res, 400, { error: 'Bad path' });
  fs.readFile(p, (e, buf) => {
    if (e) return json(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
    res.end(buf);
  });
}

async function chat(req, res) {
  const body = await readBody(req);
  const text = String(body.text || '').trim();
  const rounds = Math.min(Math.max(parseInt(body.rounds) || 1, 1), 5);
  if (!text) return json(res, 400, { error: 'Empty message' });
  if (!state.accounts.length) return json(res, 400, { error: 'Add at least one account first' });

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const send = (type, data) => res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  let aborted = false;
  res.on('close', () => { aborted = true; });

  const userMsg = { from: 'You', text, ts: Date.now() };
  state.messages.push(userMsg); save();
  send('message', { message: userMsg });

  let finished = false;
  for (let r = 0; r < rounds && !aborted && !finished; r++) {
    for (const acct of state.accounts) {
      if (aborted) break;
      send('thinking', { from: acct.name });
      const result = await runAgent(acct, systemFor(acct), `Conversation so far:\n${transcript()}\n\nWrite your next message to the group now.`);
      const msg = { from: acct.name, text: result.text || '(no reply)', error: !result.ok, ts: Date.now() };
      state.messages.push(msg); save();
      send('message', { message: msg });
      if (result.ok && /(^|\n)DONE:/.test(result.text)) { finished = true; break; }
    }
  }
  send('end', {});
  res.end();
}

function listFiles() {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 4 || out.length > 300) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1); else out.push(path.relative(WORKSPACE, p));
    }
  };
  try { walk(WORKSPACE, 0); } catch (_) {}
  return out;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/healthz') { res.writeHead(200); return res.end('ok'); }
    if (req.method === 'POST' && p === '/api/login') {
      const b = await readBody(req);
      if (!APP_PASSWORD || b.password === APP_PASSWORD) {
        const sid = crypto.randomBytes(24).toString('hex'); sessions.add(sid);
        res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; SameSite=Strict; Path=/`);
        return json(res, 200, { ok: true });
      }
      return json(res, 401, { error: 'Wrong password' });
    }
    if (!p.startsWith('/api/')) return serveStatic(req, res, p);
    if (APP_PASSWORD && !sessions.has(cookieOf(req))) return json(res, 401, { error: 'Not logged in' });

    if (req.method === 'GET' && p === '/api/state')
      return json(res, 200, { accounts: state.accounts.map(publicAccount), messages: state.messages, workspace: WORKSPACE, claudeBin: CLAUDE_BIN });

    if (req.method === 'POST' && p === '/api/accounts') {
      const b = await readBody(req);
      const name = String(b.name || '').trim().slice(0, 40);
      const type = TYPES.includes(b.type) ? b.type : 'claude';
      if (!name) return json(res, 400, { error: 'Name required' });
      const acct = { name, type, role: String(b.role || '').trim().slice(0, 400) };
      if (type === 'claude') {
        if (b.oauthToken) acct.oauthToken = String(b.oauthToken).trim();
      } else {
        acct.model = String(b.model || '').trim().slice(0, 120);
        acct.baseUrl = cleanUrl(b.baseUrl);
        if (b.apiKey) acct.apiKey = String(b.apiKey).trim();
        if (b.keyEnv) acct.keyEnv = String(b.keyEnv).trim().replace(/[^A-Za-z0-9_]/g, '');
        if (!acct.model) return json(res, 400, { error: 'Model name required' });
        if (acct.baseUrl && !/^https?:\/\//.test(acct.baseUrl)) return json(res, 400, { error: 'Base URL must start with http:// or https://' });
      }
      let id = slug(name), n = 2; const base = id;
      while (state.accounts.some(a => a.id === id)) id = `${base}-${n++}`;
      acct.id = id;
      state.accounts.push(acct);
      if (type === 'claude') fs.mkdirSync(profileDir(id), { recursive: true });
      save();
      return json(res, 200, publicAccount(acct));
    }

    const m = p.match(/^\/api\/accounts\/([^/]+)(\/check)?$/);
    if (m) {
      const id = m[1];
      if (!safeId(id)) return json(res, 400, { error: 'Bad id' });
      if (req.method === 'DELETE' && !m[2]) {
        state.accounts = state.accounts.filter(a => a.id !== id);
        fs.rmSync(profileDir(id), { recursive: true, force: true });
        save(); return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && m[2]) {
        const a = state.accounts.find(x => x.id === id);
        if (!a) return json(res, 404, { error: 'Unknown account' });
        const r = await runAgent(a, 'You are a connection test.', 'Reply with the single word: ready', { timeoutMs: 90000 });
        return json(res, 200, { signedIn: r.ok, detail: r.ok ? 'Connected' : r.text });
      }
    }

    if (req.method === 'POST' && p === '/api/reset') { state.messages = []; save(); return json(res, 200, { ok: true }); }
    if (req.method === 'POST' && p === '/api/chat') return chat(req, res);
    if (req.method === 'GET' && p === '/api/files') return json(res, 200, { files: listFiles() });
    if (req.method === 'GET' && p === '/api/file') {
      const f = path.resolve(WORKSPACE, url.searchParams.get('path') || '');
      if (!f.startsWith(path.resolve(WORKSPACE) + path.sep)) return json(res, 400, { error: 'Bad path' });
      try { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end(fs.readFileSync(f, 'utf8').slice(0, 200000)); }
      catch (_) { return json(res, 404, { error: 'Not found' }); }
    }
    json(res, 404, { error: 'Not found' });
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: String(e.message || e) }); else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Claude Team running on http://${HOST}:${PORT}`);
  if (!APP_PASSWORD) console.log('WARNING: APP_PASSWORD is not set. Only use this on localhost.');
});
