// Team Agent: a web UI where you chat with a MAIN AI that has tools (files, shell, web) and can
// delegate work to other AI accounts you add, like a small team. Zero npm dependencies.
// Account types:
//   openai    - any OpenAI-compatible API (OpenAI, OpenRouter, NVIDIA NIM, Groq, Together, DeepSeek, Gemini, Ollama...)
//   anthropic - Anthropic Messages API with an API key
const http = require('http');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const ALLOW_SHELL = process.env.ALLOW_SHELL !== '0';
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const WORKSPACE = process.env.WORKSPACE || path.join(DATA, 'workspace');
const STATE_FILE = path.join(DATA, 'state.json');
const PUBLIC = path.join(__dirname, 'public');
const MAX_STEPS = 25;
const TURN_BUDGET_MS = 15 * 60 * 1000;

const isLoopback = ['127.0.0.1', 'localhost', '::1'].includes(HOST);
if (!isLoopback && !APP_PASSWORD) {
  console.error('Refusing to listen on a public address without APP_PASSWORD. Set APP_PASSWORD and retry.');
  process.exit(1);
}
fs.mkdirSync(WORKSPACE, { recursive: true });

let workspaceWritable = true;
try { const probe = path.join(WORKSPACE, '.write-test'); fs.writeFileSync(probe, 'ok'); fs.rmSync(probe); }
catch (e) { workspaceWritable = false; console.error('WARNING: workspace is not writable:', WORKSPACE, e.message); }

let state = { accounts: [], messages: [], mainId: '' };
try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; } catch (_) {}
const TYPES = ['openai', 'anthropic'];
state.accounts = (state.accounts || []).filter(a => TYPES.includes(a.type)); // drop removed account types
const save = () => { try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 }); } catch (_) {} };
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'agent';

// Optional seeding for hosts without a persistent disk (e.g. Koyeb with no volume):
// ACCOUNTS_JSON='[{"name":"Boss","type":"openai","baseUrl":"https://openrouter.ai/api/v1","model":"...","keyEnv":"OPENROUTER_KEY","main":true}]'
try {
  for (const s of JSON.parse(process.env.ACCOUNTS_JSON || '[]')) {
    const id = slug(s.name || '');
    if (!s.name || !TYPES.includes(s.type) || state.accounts.some(a => a.id === id)) continue;
    const { main, ...rest } = s;
    state.accounts.push({ role: '', ...rest, id });
    if (main) state.mainId = id;
  }
} catch (e) { console.error('ACCOUNTS_JSON ignored:', e.message); }
if (!state.accounts.some(a => a.id === state.mainId)) state.mainId = state.accounts[0]?.id || '';

const sessions = new Set();
const cookieOf = (req) => (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('sid='))?.slice(4);
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((resolve) => {
  let b = ''; req.on('data', d => { b += d; if (b.length > 5e6) req.destroy(); });
  req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (_) { resolve({}); } });
});

const apiKeyOf = (a) => a.apiKey || (a.keyEnv ? process.env[a.keyEnv] : '') || '';
const publicAccount = (a) => ({
  id: a.id, name: a.name, role: a.role, type: a.type, model: a.model || '', baseUrl: a.baseUrl || '',
  keyEnv: a.keyEnv || '', noTools: !!a.noTools, hasKey: !!apiKeyOf(a), main: a.id === state.mainId,
});
const cleanUrl = (u) => String(u || '').trim().replace(/\/+$/, '');
const mainAccount = () => state.accounts.find(a => a.id === state.mainId);
const findAccount = (q) => { const s = String(q || '').trim().toLowerCase();
  return state.accounts.find(a => a.id === s || a.name.toLowerCase() === s); };

// ---------------- workspace (file system) ----------------
function safePath(p) {
  const root = fs.realpathSync(WORKSPACE);
  const full = path.resolve(root, String(p || '.'));
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error('Path is outside the workspace');
  let probe = full;
  while (!fs.existsSync(probe)) probe = path.dirname(probe);
  const real = fs.realpathSync(probe);
  if (real !== root && !real.startsWith(root + path.sep)) throw new Error('Path is outside the workspace');
  return full;
}
function listTree(dir, maxDepth, limit) {
  const out = [];
  const walk = (d, depth) => {
    if (depth > maxDepth || out.length >= limit) return;
    let entries = []; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(d, e.name);
      out.push(path.relative(WORKSPACE, p) + (e.isDirectory() ? '/' : ''));
      if (e.isDirectory()) walk(p, depth + 1);
    }
  };
  walk(dir, 0);
  return out;
}

// ---------------- tools ----------------
const BASE_TOOLS = [
  { name: 'list_files', description: 'List files and folders in the shared workspace (recursive, 3 levels).',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Folder, default "."' } } } },
  { name: 'read_file', description: 'Read a text file from the workspace.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'write_file', description: 'Create or overwrite a file. Parent folders are created automatically.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'append_file', description: 'Append text to the end of a file (creates it if missing).',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'replace_in_file', description: 'Replace one exact piece of text in an existing file.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, old: { type: 'string' }, new: { type: 'string' } }, required: ['path', 'old', 'new'] } },
  { name: 'move_file', description: 'Move or rename a file or folder.',
    parameters: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] } },
  { name: 'delete_file', description: 'Delete a file or folder.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'fetch_url', description: 'Download a web page or API response (GET) and return its text.',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  ...(ALLOW_SHELL ? [{ name: 'run_command', description: 'Run a shell command in the workspace folder (install packages, run scripts and tests, git, build). Times out after 2 minutes.',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }] : []),
];
const DELEGATE_TOOL = { name: 'delegate_task',
  description: 'Give a task to a teammate AI (by name) and get their report back. Teammates share the same workspace files. Be specific about what to build or check and which files are involved.',
  parameters: { type: 'object', properties: { agent: { type: 'string', description: 'Teammate name' }, task: { type: 'string' } }, required: ['agent', 'task'] } };

const isMain = (a) => a.id === state.mainId && state.accounts.length > 1;
const toolsFor = (a, ctx) => isMain(a) && !(ctx && ctx.noDelegate) ? [...BASE_TOOLS, DELEGATE_TOOL] : BASE_TOOLS;

function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.APP_PASSWORD; delete env.ACCOUNTS_JSON;
  for (const a of state.accounts) if (a.keyEnv) delete env[a.keyEnv];
  return env;
}
function runShell(command) {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], { cwd: WORKSPACE, env: cleanEnv({ HOME: DATA }), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; const add = (d) => { if (out.length < 40000) out += d; };
    child.stdout.on('data', add); child.stderr.on('data', add);
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
    child.on('error', e => { clearTimeout(timer); resolve(`Error: ${e.message}`); });
    child.on('close', (code) => { clearTimeout(timer); resolve(`exit code ${code}\n${out.slice(0, 20000)}`); });
  });
}

async function execTool(name, args, ctx) {
  try {
    switch (name) {
      case 'list_files': return listTree(safePath(args.path || '.'), 3, 250).join('\n') || '(empty)';
      case 'read_file': return fs.readFileSync(safePath(args.path), 'utf8').slice(0, 60000);
      case 'write_file': {
        const p = safePath(args.path); fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, String(args.content ?? '')); return `Wrote ${path.relative(WORKSPACE, p)} (${String(args.content ?? '').length} chars)`;
      }
      case 'append_file': {
        const p = safePath(args.path); fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.appendFileSync(p, String(args.content ?? '')); return `Appended to ${path.relative(WORKSPACE, p)}`;
      }
      case 'replace_in_file': {
        const p = safePath(args.path); const s = fs.readFileSync(p, 'utf8');
        const n = s.split(String(args.old)).length - 1;
        if (n === 0) return 'Error: text to replace was not found';
        if (n > 1) return `Error: text appears ${n} times; include more surrounding text`;
        fs.writeFileSync(p, s.replace(String(args.old), () => String(args.new ?? ''))); return 'Replaced';
      }
      case 'move_file': {
        const to = safePath(args.to); fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.renameSync(safePath(args.from), to); return 'Moved';
      }
      case 'delete_file': { const p = safePath(args.path); if (p === fs.realpathSync(WORKSPACE)) return 'Error: cannot delete the workspace root'; fs.rmSync(p, { recursive: true, force: true }); return 'Deleted'; }
      case 'fetch_url': {
        if (!/^https?:\/\//i.test(String(args.url))) return 'Error: only http(s) URLs';
        const r = await fetch(args.url, { signal: AbortSignal.timeout(30000) });
        return `HTTP ${r.status}\n${(await r.text()).slice(0, 40000)}`;
      }
      case 'run_command': return ALLOW_SHELL ? await runShell(String(args.command || '')) : 'Error: shell is disabled on this server';
      case 'delegate_task': return await delegate(ctx, args);
      default: return `Error: unknown tool ${name}`;
    }
  } catch (e) { return `Error: ${e.message}`; }
}

const toolNote = (name, a = {}) =>
  `${name}${a.agent ? ' → ' + a.agent : a.path ? ' ' + a.path : a.from ? ` ${a.from} → ${a.to}` : a.command ? ': ' + String(a.command).slice(0, 90) : a.url ? ' ' + a.url : ''}`;

// ---------------- model calls ----------------
async function postRetry(...args) {
  for (let t = 0; ; t++) {
    try { return await postJson(...args); }
    catch (e) {
      if (t < 3 && /HTTP (429|500|502|503|504)/.test(String(e.message))) { await new Promise(r => setTimeout(r, 4000 * (t + 1))); continue; }
      throw e;
    }
  }
}
async function postJson(url, headers, body, timeoutMs) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const raw = await r.text();
  let j = {}; try { j = JSON.parse(raw); } catch (_) {}
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${(j.error && (j.error.message || j.error)) || raw}`.slice(0, 600));
  return j;
}

async function agentLoop(account, system, prompt, ctx, useTools) {
  const key = apiKeyOf(account);
  const started = Date.now(); const tools = [];
  const defs = toolsFor(account, ctx);
  const note = (name, args) => { const t = toolNote(name, args); tools.push(t); ctx.onTool(account, t); };
  const stop = () => (ctx.aborted && ctx.aborted()) || Date.now() - started > TURN_BUDGET_MS;
  const left = () => Math.max(5000, Math.min(5 * 60 * 1000, TURN_BUDGET_MS - (Date.now() - started)));
  const limitMsg = '(stopped: too many tool steps or out of time)';

  if (account.type === 'anthropic') {
    const base = cleanUrl(account.baseUrl) || 'https://api.anthropic.com';
    const msgs = [{ role: 'user', content: prompt }];
    for (let step = 0; step < MAX_STEPS && !stop(); step++) {
      const body = { model: account.model, max_tokens: 8192, system, messages: msgs };
      if (useTools) body.tools = defs.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));
      const j = await postRetry(`${base}/v1/messages`, { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body, left());
      const content = j.content || [];
      const uses = content.filter(b => b.type === 'tool_use');
      if (useTools && uses.length) {
        msgs.push({ role: 'assistant', content });
        const results = [];
        for (const u of uses) { note(u.name, u.input); results.push({ type: 'tool_result', tool_use_id: u.id, content: await execTool(u.name, u.input || {}, ctx) }); }
        msgs.push({ role: 'user', content: results }); continue;
      }
      return { ok: true, text: content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim(), tools };
    }
    return { ok: true, text: limitMsg, tools };
  }

  const base = cleanUrl(account.baseUrl) || 'https://api.openai.com/v1';
  const msgs = [{ role: 'system', content: system }, { role: 'user', content: prompt }];
  for (let step = 0; step < MAX_STEPS && !stop(); step++) {
    const body = { model: account.model, messages: msgs };
    if (useTools) body.tools = defs.map(t => ({ type: 'function', function: t }));
    const j = await postRetry(`${base}/chat/completions`, { Authorization: `Bearer ${key}` }, body, left());
    const m = j.choices?.[0]?.message || {};
    if (useTools && m.tool_calls?.length) {
      m.tool_calls.forEach((tc, i) => { if (!tc.id) tc.id = `call_${step}_${i}`; });
      msgs.push({ role: 'assistant', content: m.content || null, tool_calls: m.tool_calls });
      for (const tc of m.tool_calls) {
        let args = tc.function?.arguments || {};
        if (typeof args === 'string') { try { args = JSON.parse(args || '{}'); } catch (_) { args = {}; } }
        note(tc.function?.name, args);
        msgs.push({ role: 'tool', tool_call_id: tc.id, content: await execTool(tc.function?.name, args, ctx) });
      }
      continue;
    }
    return { ok: true, text: String(m.content || '').trim(), tools };
  }
  return { ok: true, text: limitMsg, tools };
}

async function runAgent(account, system, prompt, ctx) {
  if (!apiKeyOf(account)) return { ok: false, text: 'No API key set for this account.', tools: [] };
  if (!account.model) return { ok: false, text: 'No model set for this account.', tools: [] };
  const useTools = !account.noTools;
  try {
    return await agentLoop(account, system, prompt, ctx, useTools);
  } catch (e) {
    const msg = String(e.message || e);
    if (useTools && /HTTP (400|404|422)/.test(msg) && /tool|function/i.test(msg)) { // model has no tool support
      try {
        const r = await agentLoop(account, system, prompt, ctx, false);
        return { ...r, text: `${r.text}\n\n(Note: this model does not support tools, so it could not create files.)` };
      } catch (e2) { return { ok: false, text: String(e2.message || e2), tools: [] }; }
    }
    return { ok: false, text: msg, tools: [] };
  }
}

// ---------------- team ----------------
const transcript = (n = 30000) => state.messages.map(m => `[${m.from}]: ${m.text}`).join('\n\n').slice(-n);
const teamList = (except) => state.accounts.filter(a => a.id !== except).map(a => `- ${a.name}${a.role ? ` (${a.role})` : ''} [${a.model}]`).join('\n');
const toolLine = (a) => a.noTools ? 'You cannot use tools. Put any code directly in your message in fenced code blocks.'
  : `You have tools for the shared workspace (the current folder), so actually create and edit files with them instead of pasting large code into the chat${ALLOW_SHELL ? ', and run commands to install, build, run and test' : ''}.`;

function mainSystem(a) {
  const others = teamList(a.id);
  return `You are "${a.name}", the MAIN AI of a small team, chatting with a human in a web app.
${a.role ? `Your role: ${a.role}\n` : ''}${toolLine(a)}
${others ? `Your teammates:\n${others}\nUse delegate_task to hand work to them (for example coding, reviewing, testing, debugging, research, writing docs). Give each a clear, self-contained task, then check their report and the files they changed, fix problems or send follow-up tasks, and finally tell the human what was done. Do simple things yourself.` : 'You have no teammates yet; do the work yourself.'}
Keep chat replies concise: what you did, which files, what is left. Ask the human only when you are truly blocked.`;
}
function workerSystem(a, boss) {
  return `You are "${a.name}", a worker AI on a team led by "${boss.name}".
${a.role ? `Your role: ${a.role}\n` : ''}${toolLine(a)}
Do the task you were given, then reply with a short report: what you did, files created or changed, and any problems.`;
}

async function delegate(ctx, args) {
  const boss = ctx.account;
  const w = findAccount(args.agent);
  if (!w) return `Error: no teammate named "${args.agent}". Available:\n${teamList(boss.id)}`;
  if (w.id === boss.id) return 'Error: you cannot delegate to yourself';
  ctx.send('thinking', { from: w.name });
  const prompt = `Task from ${boss.name}:\n${String(args.task || '')}\n\nRecent conversation for context:\n${transcript(6000)}`;
  const r = await runAgent(w, workerSystem(w, boss), prompt, { ...ctx, account: w });
  const msg = { from: w.name, text: r.text || '(no reply)', error: !r.ok, tools: r.tools, worker: true, ts: Date.now() };
  state.messages.push(msg); save(); ctx.send('message', { message: msg });
  return (r.ok ? '' : 'The teammate failed: ') + (r.text || '(no reply)').slice(0, 12000);
}

// ---------------- group project mode ----------------
// All AIs build one project together: the lead plans an equal split, everyone works on their part in
// parallel in the shared workspace, optionally cross-reviews a teammate's part, then the lead integrates.
const GROUP_CONCURRENCY = Math.max(1, parseInt(process.env.GROUP_CONCURRENCY) || 4);

async function pool(items, limit, fn, aborted) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length && !(aborted && aborted())) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

function extractJson(text) {
  const t = String(text || '').replace(/```json|```/gi, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch (_) { return null; }
}

function normalizePlan(raw, agents) {
  const parts = []; const used = new Set();
  for (const p of (raw?.parts || [])) {
    const a = findAccount(p.agent);
    if (!a || !agents.includes(a) || used.has(a.id)) continue;
    used.add(a.id);
    parts.push({ agent: a, title: String(p.title || 'Part'), description: String(p.description || ''),
      files: Array.isArray(p.files) ? p.files.map(String) : [], share: Number(p.share) > 0 ? Number(p.share) : 0 });
  }
  const real = parts.length; const realSum = parts.reduce((s, p) => s + p.share, 0);
  const allWeighted = real > 0 && parts.every(p => p.share > 0);
  for (const a of agents) if (!used.has(a.id)) {
    parts.push({ agent: a, title: 'Support: tests, docs and polish', files: [],
      description: 'Help where needed: write tests and documentation, fill gaps and fix problems. Read PLAN.md and your teammates\' files first.',
      share: allWeighted ? realSum / real : 0 });
  }
  const sum = parts.reduce((s, p) => s + p.share, 0);
  if (sum <= 0 || parts.some(p => p.share <= 0)) parts.forEach(p => { p.share = 100 / parts.length; });
  else parts.forEach(p => { p.share = p.share * 100 / sum; });
  return { summary: String(raw?.summary || ''), notes: String(raw?.shared_notes || ''), parts };
}

function fallbackPlan(agents, request) {
  return normalizePlan({ summary: request.slice(0, 200), shared_notes: 'No detailed plan was produced. Claim your area by reading PLAN.md and list_files before creating anything, keep folders tidy, and do not overwrite teammates\' files.',
    parts: agents.map((a, i) => ({ agent: a.name, title: `Part ${i + 1} of ${agents.length}`, share: 100 / agents.length,
      description: `Take the ${i + 1}${['st','nd','rd'][i] || 'th'} of ${agents.length} equal slices of this project: ${request}. Decide a sensible slice by role and by what teammates are already doing.` })) }, agents);
}

const planText = (plan) =>
  `Plan (${plan.parts.length} AIs, 100% total)${plan.summary ? `: ${plan.summary}` : ''}\n` +
  plan.parts.map(p => `• ${p.agent.name}, ${Math.round(p.share)}%: ${p.title}${p.files.length ? `  [${p.files.join(', ')}]` : ''}`).join('\n') +
  (plan.notes ? `\n\nShared notes: ${plan.notes}` : '');

function planMarkdown(request, plan) {
  return `# Project plan\n\n**Request:** ${request}\n\n${plan.summary ? `**Summary:** ${plan.summary}\n\n` : ''}${plan.notes ? `## Shared conventions\n${plan.notes}\n\n` : ''}## Split of work\n` +
    plan.parts.map(p => `### ${p.agent.name}: ${p.title} (${Math.round(p.share)}%)\n${p.description}\n${p.files.length ? `Files: ${p.files.join(', ')}\n` : ''}`).join('\n');
}

const groupSystem = (a, lead, agents) => `You are "${a.name}", one of ${agents.length} AIs building a project together with a human. "${lead.name}" is the team lead.
${a.role ? `Your role: ${a.role}\n` : ''}${toolLine(a)}
Everyone works at the same time in the same workspace folder. Stay inside your own part, do not overwrite or delete teammates' files (read them if you need to fit with them), and follow the agreed structure in PLAN.md. Test what you build when you can. Finish with a short report: files created or changed, status, and anything teammates must know.`;

const sayPost = (ctx, msg) => { const m = { ts: Date.now(), ...msg }; state.messages.push(m); save(); ctx.send('message', { message: m }); return m; };
const phase = (ctx, text) => sayPost(ctx, { from: 'System', text, phase: true });

async function groupProject(ctx, request, { review }) {
  const agents = state.accounts.filter(a => apiKeyOf(a) && a.model);
  const lead = agents.find(a => a.id === state.mainId) || agents[0];
  if (agents.length < 2) {
    const r = await runAgent(lead || mainAccount(), mainSystem(lead || mainAccount()), `Conversation so far:\n${transcript()}\n\nReply to the human's latest message now.`, ctx);
    return sayPost(ctx, { from: (lead || mainAccount()).name, text: r.text || '(no reply)', error: !r.ok, tools: r.tools, main: true });
  }
  const aborted = () => ctx.aborted && ctx.aborted();
  const roster = agents.map(a => `- ${a.name}${a.role ? ` (${a.role})` : ''} [${a.model}]${a.noTools ? ' (no tools: text only)' : ''}`).join('\n');

  // 1. Plan
  phase(ctx, `Phase 1 of ${review ? 4 : 3}: ${lead.name} is planning the split between ${agents.length} AIs`);
  ctx.send('thinking', { from: lead.name });
  const pr = await runAgent({ ...lead, noTools: true },
    'You are a project planner who splits software and writing projects between several AI workers. Reply with JSON only.',
    `PLAN_REQUEST\nProject request from the human:\n${request}\n\nWorkers (each must get exactly one part):\n${roster}\n\n` +
    `Split the project into ${agents.length} parts of roughly equal size (about ${Math.round(100 / agents.length)}% each), unless the roles clearly justify different weights. ` +
    'Make parts independent so everyone can work at once, define clear file/folder ownership and any interfaces between parts (API routes, function names, data formats), and choose a simple stack.\n' +
    'Reply with JSON only in this shape: {"summary":"one line","shared_notes":"stack, folder structure, interfaces and conventions everyone must follow","parts":[{"agent":"exact worker name","title":"short title","share":25,"description":"detailed deliverables","files":["paths owned by this worker"]}]}',
    { ...ctx, account: lead, onTool() {} });
  ctx.send('done', { from: lead.name });
  const raw = pr.ok ? extractJson(pr.text) : null;
  const plan = raw ? normalizePlan(raw, agents) : fallbackPlan(agents, request);
  try { fs.writeFileSync(path.join(WORKSPACE, 'PLAN.md'), planMarkdown(request, plan)); } catch (_) {}
  sayPost(ctx, { from: lead.name, text: planText(plan) + (raw ? '' : '\n\n(The plan could not be parsed, so the work was split evenly.)'), main: true });

  // 2. Build in parallel
  phase(ctx, `Phase 2 of ${review ? 4 : 3}: all ${agents.length} AIs are building their parts at the same time`);
  const brief = `Project request from the human:\n${request}\n\nFull plan (see PLAN.md):\n${planText(plan)}`;
  const results = await pool(plan.parts, GROUP_CONCURRENCY, async (part) => {
    ctx.send('thinking', { from: part.agent.name });
    const r = await runAgent(part.agent, groupSystem(part.agent, lead, agents),
      `YOUR PART\n${brief}\n\nYour part is "${part.title}" (${Math.round(part.share)}% of the project):\n${part.description}\n${part.files.length ? `Files you own: ${part.files.join(', ')}\n` : ''}\nBuild it now with your tools, then report.`,
      { ...ctx, account: part.agent, noDelegate: true });
    sayPost(ctx, { from: part.agent.name, text: r.text || '(no reply)', error: !r.ok, tools: r.tools, worker: true });
    return { part, r };
  }, aborted);

  // 3. Cross-review
  let reviews = [];
  if (review && !aborted()) {
    phase(ctx, `Phase 3 of 4: each AI reviews a teammate's part and fixes problems`);
    reviews = await pool(plan.parts, GROUP_CONCURRENCY, async (part, i) => {
      const target = plan.parts[(i + 1) % plan.parts.length];
      ctx.send('thinking', { from: part.agent.name });
      const r = await runAgent(part.agent, groupSystem(part.agent, lead, agents),
        `REVIEW TASK\n${brief}\n\nReview ${target.agent.name}'s part ("${target.title}", files: ${target.files.join(', ') || 'see PLAN.md and list_files'}). Read the files, run or test them if possible, and check they follow the plan and fit with the rest. Fix clear bugs directly with small edits; report bigger problems. Reply with a short review.`,
        { ...ctx, account: part.agent, noDelegate: true });
      sayPost(ctx, { from: part.agent.name, text: `Review of ${target.agent.name}'s part:\n${r.text || '(no reply)'}`, error: !r.ok, tools: r.tools, worker: true });
      return { part, target, r };
    }, aborted);
  }

  // 4. Lead integrates and finishes
  if (aborted()) return;
  phase(ctx, `Phase ${review ? 4 : 3} of ${review ? 4 : 3}: ${lead.name} is putting everything together`);
  ctx.send('thinking', { from: lead.name });
  const failed = results.filter(x => x && !x.r.ok).map(x => `${x.part.agent.name} (${x.part.title}): ${x.r.text}`);
  const reports = results.filter(Boolean).map(x => `## ${x.part.agent.name}: ${x.part.title}\n${(x.r.text || '').slice(0, 2500)}`).join('\n\n');
  const reviewTxt = reviews.filter(Boolean).map(x => `## ${x.part.agent.name} reviewed ${x.target.agent.name}\n${(x.r.text || '').slice(0, 1500)}`).join('\n\n');
  const fin = await runAgent(lead, groupSystem(lead, lead, agents),
    `INTEGRATION\n${brief}\n\nTeam reports:\n${reports}\n${reviewTxt ? `\nReviews:\n${reviewTxt}\n` : ''}${failed.length ? `\nThese parts FAILED and still need doing, finish them yourself:\n${failed.join('\n')}\n` : ''}\n` +
    'Now integrate: list_files, read the key files, run the project or its tests, fix integration problems (or use delegate_task for bigger fixes), complete anything missing, and make sure a README.md explains how to run it. Then reply to the human with a concise final summary: what was built, the main files, and how to run it.',
    { ...ctx, account: lead });
  sayPost(ctx, { from: lead.name, text: fin.text || '(no reply)', error: !fin.ok, tools: fin.tools, main: true });
}

let busy = false;
async function chat(req, res) {
  const body = await readBody(req);
  const text = String(body.text || '').trim();
  const main = mainAccount();
  if (!text) return json(res, 400, { error: 'Empty message' });
  if (!main) return json(res, 400, { error: 'Add at least one account first' });
  if (busy) return json(res, 409, { error: 'The team is still working on the previous message' });
  busy = true;

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const send = (type, data) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`); };
  let aborted = false; res.on('close', () => { aborted = true; });
  try {
    const userMsg = { from: 'You', text, ts: Date.now() };
    state.messages.push(userMsg); save(); send('message', { message: userMsg });
    send('thinking', { from: main.name });
    const ctx = { account: main, send, aborted: () => aborted, onTool: (acct, t) => send('tool', { from: acct.name, tool: t }) };
    if (body.mode === 'group') {
      await groupProject(ctx, text, { review: body.review !== false });
    } else {
      const r = await runAgent(main, mainSystem(main), `Conversation so far:\n${transcript()}\n\nReply to the human's latest message now.`, ctx);
      const msg = { from: main.name, text: r.text || '(no reply)', error: !r.ok, tools: r.tools, main: true, ts: Date.now() };
      state.messages.push(msg); save(); send('message', { message: msg });
    }
  } catch (e) { send('message', { message: { from: 'System', text: 'Error: ' + (e.message || e), error: true } }); }
  finally { busy = false; send('end', {}); res.end(); }
}

// ---------------- http ----------------
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
      return json(res, 200, { accounts: state.accounts.map(publicAccount), messages: state.messages, mainId: state.mainId, workspace: WORKSPACE, workspaceWritable, shell: ALLOW_SHELL, busy });

    if (req.method === 'POST' && p === '/api/accounts') {
      const b = await readBody(req);
      const name = String(b.name || '').trim().slice(0, 40);
      const type = TYPES.includes(b.type) ? b.type : 'openai';
      if (!name) return json(res, 400, { error: 'Name required' });
      const acct = { name, type, role: String(b.role || '').trim().slice(0, 400), model: String(b.model || '').trim().slice(0, 120), baseUrl: cleanUrl(b.baseUrl) };
      if (!acct.model) return json(res, 400, { error: 'Model name required' });
      if (acct.baseUrl && !/^https?:\/\//.test(acct.baseUrl)) return json(res, 400, { error: 'Base URL must start with http:// or https://' });
      if (b.apiKey) acct.apiKey = String(b.apiKey).trim();
      if (b.keyEnv) acct.keyEnv = String(b.keyEnv).trim().replace(/[^A-Za-z0-9_]/g, '');
      if (b.noTools) acct.noTools = true;
      let id = slug(name), n = 2; const base = id;
      while (state.accounts.some(a => a.id === id)) id = `${base}-${n++}`;
      acct.id = id; state.accounts.push(acct);
      if (!state.mainId) state.mainId = id;
      save(); return json(res, 200, publicAccount(acct));
    }

    const m = p.match(/^\/api\/accounts\/([^/]+)(\/check|\/main)?$/);
    if (m) {
      const a = state.accounts.find(x => x.id === m[1]);
      if (!a) return json(res, 404, { error: 'Unknown account' });
      if (req.method === 'DELETE' && !m[2]) {
        state.accounts = state.accounts.filter(x => x.id !== a.id);
        if (state.mainId === a.id) state.mainId = state.accounts[0]?.id || '';
        save(); return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && m[2] === '/main') { state.mainId = a.id; save(); return json(res, 200, { ok: true }); }
      if (req.method === 'POST' && m[2] === '/check') {
        const r = await runAgent({ ...a, noTools: true }, 'You are a connection test.', 'Reply with the single word: ready', { onTool() {}, send() {} });
        return json(res, 200, { ok: r.ok, detail: r.ok ? 'Connected' : r.text });
      }
    }

    if (req.method === 'POST' && p === '/api/reset') { state.messages = []; save(); return json(res, 200, { ok: true }); }
    if (req.method === 'POST' && p === '/api/chat') return chat(req, res);

    // file manager
    if (req.method === 'GET' && p === '/api/files') return json(res, 200, { files: listTree(WORKSPACE, 6, 500) });
    if (p === '/api/file') {
      if (req.method === 'POST') {
        const b = await readBody(req);
        const f = safePath(b.path); if (f === fs.realpathSync(WORKSPACE)) return json(res, 400, { error: 'Bad path' });
        fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, String(b.content ?? ''));
        return json(res, 200, { ok: true });
      }
      const f = safePath(url.searchParams.get('path') || '');
      if (req.method === 'DELETE') { fs.rmSync(f, { recursive: true, force: true }); return json(res, 200, { ok: true }); }
      if (req.method === 'GET') {
        const dl = !!url.searchParams.get('download');
        const headers = { 'Content-Type': dl ? 'application/octet-stream' : 'text/plain; charset=utf-8' };
        if (dl) headers['Content-Disposition'] = `attachment; filename="${path.basename(f).replace(/"/g, '')}"`;
        try { const buf = fs.readFileSync(f); res.writeHead(200, headers); return res.end(dl ? buf : buf.subarray(0, 300000)); }
        catch (_) { return json(res, 404, { error: 'Not found' }); }
      }
    }
    json(res, 404, { error: 'Not found' });
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: String(e.message || e) }); else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Team Agent running on http://${HOST}:${PORT}`);
  if (!APP_PASSWORD) console.log('WARNING: APP_PASSWORD is not set. Only use this on localhost.');
});
