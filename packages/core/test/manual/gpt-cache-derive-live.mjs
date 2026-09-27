/**
 * GPT 缓存反演端到端验收(手工,💰 走本地网关打真实上游,不进 CI)。
 *
 * 每个场景的命中真值由构造保证:新会话冷启动 = 0;同会话下一轮 = 上一轮的 prompt
 * (T − 可见输出,另有约 7 token 固定尾巴不进缓存)。记录网关回的 prompt_tokens(T)、
 * completion_tokens(v 估算)、cached_tokens(derived 反演)与 kiro_metering.usage(credits),
 * 以及回复原文(离线用 tokenizer 数真实输出,拆开「公式误差」与「v 估算误差」)。
 *
 * 场景:S1 冷启动三档前缀 / S2 同会话续写 / S3 续写 + 大段新内容(部分命中)/ S4 冷启动长输出与
 * 短文输出 / S5 续写 + 长输出 / S6 续写 + 短文输出 / S7 两轮都 effort=medium(隐藏推理)/
 * S8 sol 走 Responses 冷启动 + 续写 / S9 同会话 effort none → medium(上游缓存失效,真值 0)。
 * 每条记录的 `truth` 标注真值口径:`zero` 或 `prev`(上一轮 prompt)。网关需以默认 override
 * 模式启动(cached_tokens 才有值)。
 *
 * ```bash
 * K2C_BASE=http://127.0.0.1:18951 K2C_KEY=... node test/manual/gpt-cache-derive-live.mjs
 * ```
 * `K2C_ONLY=S1,S2` 挑场景;结果追加到 `K2C_REPORT`(默认 /tmp/k2c-gpt-derive/run.jsonl)。
 */

import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { KEY, postJson, RESPONSES_PATH, responsesHeaders, seededDoc } from './_harness.mjs';

const CHAT_PATH = '/openai/v1/chat/completions';
const LUNA = 'gpt-5.6-luna';
const SOL = 'gpt-5.6-sol';
const OUT = process.env.K2C_REPORT ?? '/tmp/k2c-gpt-derive/run.jsonl';
const ONLY = new Set((process.env.K2C_ONLY ?? 'S1,S2,S3,S4,S5,S6,S7,S8,S9').split(','));
const RUN = randomUUID().slice(0, 8);
mkdirSync(dirname(OUT), { recursive: true });
if (!KEY) throw new Error('K2C_KEY is required');

let seed = Number.parseInt(RUN.slice(0, 6), 16);
const nextDoc = (words) => seededDoc(words, ++seed);

const ASK_OK = 'Reply with exactly: OK';
const ASK_SEQ = 'Output the integers from 1 to 1600 in order, separated by single spaces, on one line. Output nothing else.';
const ASK_PROSE = 'Write one paragraph of about 150 words describing the ocean at dawn. Plain prose only.';
const ASK_REASON =
  'How many prime numbers are there below 600? Reply with only the integer, no explanation.';

function record(rec) {
  const line = { run: RUN, ...rec };
  appendFileSync(OUT, `${JSON.stringify(line)}\n`);
  const { text, ...brief } = line;
  console.log(JSON.stringify({ ...brief, text: text?.slice(0, 40) }));
}

/** Chat 会话:messages 累积,prompt_cache_key 固定 → 网关派生同一个 conversationId。 */
function chatSession(model) {
  const key = `k2c-derive-${RUN}-${randomUUID().slice(0, 8)}`;
  const messages = [];
  return async (scenario, label, content, effort = 'none', truth = 'prev') => {
    messages.push({ role: 'user', content });
    const { status, raw } = await postJson(CHAT_PATH, responsesHeaders(), {
      model,
      messages,
      reasoning_effort: effort,
      prompt_cache_key: key,
      stream: false,
    });
    const body = status === 200 ? JSON.parse(raw) : undefined;
    const text = body?.choices?.[0]?.message?.content ?? '';
    messages.push({ role: 'assistant', content: text });
    record({
      scenario,
      label,
      protocol: 'chat',
      model,
      effort,
      truth,
      session: key,
      status,
      T: body?.usage?.prompt_tokens,
      vEst: body?.usage?.completion_tokens,
      cached: body?.usage?.prompt_tokens_details?.cached_tokens,
      credits: body?.usage?.kiro_metering?.usage,
      text,
      ...(status === 200 ? {} : { error: raw.slice(0, 300) }),
    });
  };
}

/** Responses 会话:input items 累积,同样靠 prompt_cache_key 固定会话。 */
function responsesSession(model) {
  const key = `k2c-derive-${RUN}-${randomUUID().slice(0, 8)}`;
  const input = [];
  return async (scenario, label, content, effort = 'none', truth = 'prev') => {
    input.push({ type: 'message', role: 'user', content });
    const { status, raw } = await postJson(RESPONSES_PATH, responsesHeaders(), {
      model,
      input,
      reasoning: { effort },
      prompt_cache_key: key,
      stream: false,
    });
    const body = status === 200 ? JSON.parse(raw) : undefined;
    const text = (body?.output ?? [])
      .filter((o) => o.type === 'message')
      .flatMap((o) => o.content.map((c) => c.text))
      .join('');
    input.push({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text }],
    });
    record({
      scenario,
      label,
      protocol: 'responses',
      model,
      effort,
      truth,
      session: key,
      status,
      T: body?.usage?.input_tokens,
      vEst: body?.usage?.output_tokens,
      cached: body?.usage?.input_tokens_details?.cached_tokens,
      credits: body?.usage?.kiro_metering?.usage,
      text,
      ...(status === 200 ? {} : { error: raw.slice(0, 300) }),
    });
  };
}

// S1 冷启动三档 + S2 同会话续写(+ S3 部分命中 / S5 长输出 / S6 短文 挂在对应会话后面)
const sessions = {};
if (ONLY.has('S1')) {
  for (const [name, words] of [
    ['small', 2000],
    ['mid', 8000],
    ['large', 20000],
  ]) {
    const s = chatSession(LUNA);
    sessions[name] = s;
    await s('S1-cold', `${name}-A1`, `${nextDoc(words)}\n\n${ASK_OK}`);
    if (ONLY.has('S2')) await s('S2-warm', `${name}-A2`, 'Reply with exactly: OK AGAIN');
  }
}
if (ONLY.has('S3') && sessions.mid) {
  await sessions.mid('S3-partial', 'mid-A3', `${nextDoc(4000)}\n\n${ASK_OK}`);
}
if (ONLY.has('S5') && sessions.large) {
  await sessions.large('S5-warm-long-out', 'large-A3', ASK_SEQ);
}
if (ONLY.has('S6') && sessions.small) {
  await sessions.small('S6-warm-prose', 'small-A3', ASK_PROSE);
}

// S4 冷启动 + 长输出 / 短文:命中真值 0,专测可见输出 v 的估算偏差
if (ONLY.has('S4')) {
  await chatSession(LUNA)('S4-cold-long-out', 'seq1600', ASK_SEQ);
  await chatSession(LUNA)('S4-cold-prose', 'prose150', ASK_PROSE);
}

// S7 两轮都 effort=medium:命中真值 = 上一轮 prompt,量化隐藏推理造成的低估
if (ONLY.has('S7')) {
  const s = chatSession(LUNA);
  await s('S7-reasoning', 'A1-medium', `${nextDoc(8000)}\n\n${ASK_OK}`, 'medium');
  await s('S7-reasoning', 'A2-medium', ASK_REASON, 'medium');
}

// S9 同会话 effort none → medium:上游缓存失效(credits 与冷请求相同),真值按 0
if (ONLY.has('S9')) {
  const s = chatSession(LUNA);
  await s('S9-effort-switch', 'A1-none', `${nextDoc(8000)}\n\n${ASK_OK}`);
  await s('S9-effort-switch', 'A2-medium', ASK_OK, 'medium', 'zero');
}

// S8 sol × Responses:倍率 4.4 + Codex 路径的 cached_tokens
if (ONLY.has('S8')) {
  const s = responsesSession(SOL);
  await s('S8-sol-responses', 'A1', `${nextDoc(2000)}\n\n${ASK_OK}`);
  await s('S8-sol-responses', 'A2', 'Reply with exactly: OK AGAIN');
}

console.log(`done run=${RUN} → ${OUT}`);
