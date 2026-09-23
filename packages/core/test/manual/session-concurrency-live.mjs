#!/usr/bin/env node
/**
 * 同一会话键下并发在途的串话检测(💰 打真实上游,不进 CI)。
 *
 * 每组共用一个客户端会话键(= 同一个上游 conversationId),组内对话**同时在途**:
 *   - 主对话 ×3:第 1 轮各埋一个暗号,第 2 轮带自己的历史问回暗号 → 必须答出自己的、不含别人的;
 *   - 新对话 ×2(每轮都有):不带历史问暗号 → 必须 NONE,且不含任何暗号;
 *   - subagent:Messages 组是 Claude Code 形态(同一 `metadata.user_id` + `x-claude-code-agent-id`、另一套
 *     system;一个只问、一个也埋暗号),
 *     Responses 组是 Codex 形态(同一 `prompt_cache_key`、`thread-id` 不同 = 网关映射成 subagent 会话,
 *     子线程也各埋暗号)。
 * 四组(Messages×Claude、Messages×GPT、Chat×GPT、Responses×GPT + 子线程)一起并发。
 * 见 PITFALLS「会话身份映射到 kiro-cli」。
 *
 * ```bash
 * K2C_KEY=$(grep '^KIRO2CLAUDE_API_KEY=' .env | cut -d= -f2-) K2C_BASE=http://127.0.0.1:8080 \
 *   node packages/core/test/manual/session-concurrency-live.mjs
 * ```
 * `CLAUDE_MODEL` / `K2C_GPT_MODEL`(默认 gpt-5.6-luna)换模型。
 */

import { randomUUID } from 'node:crypto';
import {
  CLAUDE_MODEL,
  CLAUDE_PATH,
  claudeHeaders,
  KEY,
  postJson,
  RESPONSES_PATH,
  reporter,
  responsesHeaders,
} from './_harness.mjs';

const CHAT_PATH = '/openai/v1/chat/completions';
const GPT = process.env.K2C_GPT_MODEL ?? 'gpt-5.6-luna';
const SET = (nonce) => `The secret code word for this chat is ${nonce}. Reply only with OK.`;
const ASK =
  'Did anyone give you a secret code word in this conversation? If so, reply with exactly that ' +
  'code word and nothing else. If not, reply exactly NONE.';

if (!KEY) {
  console.error('K2C_KEY missing');
  process.exit(1);
}

const report = reporter();
const allNonces = new Set();
const newNonce = () => {
  const n = `ZEBRA-${Math.floor(Math.random() * 9e5 + 1e5)}`;
  allNonces.add(n);
  return n;
};

// ── 三种协议的「发一轮、取文本」 ────────────────────────────────────────────

/** turns: [{role, text}];Messages 用 metadata.user_id 携带会话,subagent 另带 x-claude-code-agent-id。 */
async function viaMessages(model, session, turns, system, agentId) {
  const headers = { ...claudeHeaders(), ...(agentId ? { 'x-claude-code-agent-id': agentId } : {}) };
  const { status, raw } = await postJson(CLAUDE_PATH, headers, {
    model,
    max_tokens: 200,
    thinking: { type: 'disabled' },
    metadata: { user_id: `user_probe_account__session_${session}` },
    ...(system ? { system } : {}),
    messages: turns.map((t) => ({ role: t.role, content: t.text })),
  });
  const body = safeJson(raw);
  const text = (body?.content ?? []).map((b) => b.text ?? '').join('');
  return { status, text };
}

async function viaChat(model, key, turns) {
  const { status, raw } = await postJson(CHAT_PATH, responsesHeaders(), {
    model,
    max_tokens: 200,
    reasoning_effort: 'none',
    prompt_cache_key: key,
    messages: turns.map((t) => ({ role: t.role, content: t.text })),
  });
  return { status, text: safeJson(raw)?.choices?.[0]?.message?.content ?? '' };
}

async function viaResponses(model, key, threadId, turns) {
  const { status, raw } = await postJson(
    RESPONSES_PATH,
    { ...responsesHeaders(), 'thread-id': threadId },
    {
      model,
      stream: false,
      reasoning: { effort: 'none' },
      prompt_cache_key: key,
      input: turns.map((t) => ({
        type: 'message',
        role: t.role,
        content: [{ type: t.role === 'user' ? 'input_text' : 'output_text', text: t.text }],
      })),
    },
  );
  const out = safeJson(raw)?.output ?? [];
  const text = out
    .filter((i) => i.type === 'message')
    .flatMap((i) => i.content ?? [])
    .map((c) => c.text ?? '')
    .join('');
  return { status, text };
}

function safeJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

// ── 判定 ─────────────────────────────────────────────────────────────────

function foreignNonces(text, own) {
  return [...allNonces].filter((n) => n !== own && text.includes(n));
}

function expectOwn(name, r, own) {
  const foreign = foreignNonces(r.text, own);
  const ok = r.status === 200 && r.text.includes(own) && foreign.length === 0;
  report.record(name, ok, ok ? own : `status=${r.status} text=${JSON.stringify(r.text.slice(0, 80))}`);
}

function expectNone(name, r) {
  const leaked = foreignNonces(r.text, undefined);
  const ok = r.status === 200 && /\bNONE\b/.test(r.text) && leaked.length === 0;
  report.record(name, ok, ok ? 'NONE' : `status=${r.status} text=${JSON.stringify(r.text.slice(0, 80))}`);
}

// ── 一组:同一会话键下的主对话 + 新对话 + subagent ─────────────────────────

/**
 * send(conv, turns) 发一轮;conv 描述这段对话在协议里的身份(Responses 的 thread-id、Messages 的
 * system)。主对话与 subagent 都走两轮,新对话只问一次;probeConv 决定新对话落在哪个会话。
 */
async function runGroup(label, send, convs, probeConv = {}) {
  const actors = convs.map((c) => ({ ...c, nonce: c.plants ? newNonce() : undefined, turns: [] }));
  const planters = actors.filter((a) => a.plants);
  const firstProbe = () =>
    send({ ...probeConv, id: `probe-${randomUUID().slice(0, 6)}` }, [{ role: 'user', text: ASK }]);

  // 第 1 轮:埋暗号 与 新对话打探 同时在途
  const r1 = await Promise.all([
    ...planters.map(async (a) => {
      a.turns.push({ role: 'user', text: SET(a.nonce) });
      const r = await send(a, a.turns);
      a.turns.push({ role: 'assistant', text: r.text || 'OK' });
      return r;
    }),
    firstProbe(),
    firstProbe(),
  ]);
  for (const [i, a] of planters.entries())
    report.record(`${label} ${a.id} 埋暗号`, r1[i].status === 200, `status=${r1[i].status}`);
  expectNone(`${label} 新对话#1(与埋暗号同时在途)`, r1[planters.length]);
  expectNone(`${label} 新对话#2(与埋暗号同时在途)`, r1[planters.length + 1]);

  // 第 2 轮:各自带历史问回暗号 + 不埋暗号的 subagent + 新对话,同时在途
  const quiet = actors.filter((a) => !a.plants);
  const r2 = await Promise.all([
    ...planters.map((a) => send(a, [...a.turns, { role: 'user', text: ASK }])),
    ...quiet.map((a) => send(a, [{ role: 'user', text: a.task ?? ASK }])),
    firstProbe(),
    firstProbe(),
  ]);
  for (const [i, a] of planters.entries()) expectOwn(`${label} ${a.id} 问回自己的暗号`, r2[i], a.nonce);
  for (const [j, a] of quiet.entries())
    expectNone(`${label} ${a.id}(同会话键、不带历史)`, r2[planters.length + j]);
  expectNone(`${label} 新对话#3(与问回同时在途)`, r2[planters.length + quiet.length]);
  expectNone(`${label} 新对话#4(与问回同时在途)`, r2[planters.length + quiet.length + 1]);
}

const CC_SUBAGENT_SYSTEM =
  'You are a sub-agent launched by a coding assistant to complete one focused task. ' +
  'Answer the task directly.';
const SUB_TASK = `Task from the main agent: ${ASK}`;

const messagesGroup = (label, model) => {
  const session = randomUUID();
  return runGroup(
    label,
    (conv, turns) => viaMessages(model, session, turns, conv.system, conv.agentId),
    [
      { id: 'main-1', plants: true },
      { id: 'main-2', plants: true },
      { id: 'main-3', plants: true },
      { id: 'subagent', system: CC_SUBAGENT_SYSTEM, task: SUB_TASK, agentId: randomUUID().slice(0, 17) },
      { id: 'subagent-planter', system: CC_SUBAGENT_SYSTEM, agentId: randomUUID().slice(0, 17), plants: true },
    ],
  );
};

const chatGroup = () => {
  const key = randomUUID();
  return runGroup(`[chat ${GPT}]`, (_conv, turns) => viaChat(GPT, key, turns), [
    { id: 'conv-1', plants: true },
    { id: 'conv-2', plants: true },
    { id: 'conv-3', plants: true },
  ]);
};

const responsesGroup = () => {
  const key = randomUUID();
  // 根线程 thread-id = key;子线程 thread-id 各不相同 → 网关按 subagent 会话映射
  return runGroup(
    `[responses ${GPT}]`,
    (conv, turns) => viaResponses(GPT, key, conv.thread ?? conv.id, turns),
    [
      { id: 'parent', thread: key, plants: true },
      { id: 'child-1', plants: true },
      { id: 'child-2', plants: true },
      { id: 'child-quiet', task: SUB_TASK },
    ],
    // 新对话与父线程同一个 conversationId(thread-id = key)
    { thread: key },
  );
};

const started = Date.now();
await Promise.all([
  messagesGroup(`[messages ${CLAUDE_MODEL}]`, CLAUDE_MODEL),
  messagesGroup(`[messages ${GPT}]`, GPT),
  chatGroup(),
  responsesGroup(),
]);
console.log(`\n用时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
report.finish();
