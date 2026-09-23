#!/usr/bin/env node
/**
 * 会话键 → conversationId 与推理往返的真实上游验收(💰 打真实上游,不进 CI)。
 *
 *   1. 隔离:会话 A 埋一个随机暗号,再用**同一个** `prompt_cache_key`(= 同一个 conversationId)
 *      开一段全新的会话 B 问暗号,B 必须答 NONE;带 A 的历史问(正对照)必须答得出。
 *   2. 缓存:同键第二轮的 credit 必须明显低于第一轮(GPT;Claude 短提示低于缓存门槛,不判)。
 *   3. 推理往返:GPT 与 claude-opus-5 各一次,effort high 带 `include:["reasoning.encrypted_content"]`,
 *      把回来的 reasoning item 原样放回下一轮,上游必须照收(200、有输出)。签名是否被接受要看网关
 *      日志里没有 `retrying without reasoningContent`。
 *
 * env 与其它 💰 探针同一套(`_harness.mjs`):`K2C_KEY`(必填)、`K2C_BASE`;
 * `K2C_ISOLATION_MODELS` 逗号分隔(默认 gpt-5.6-luna,gpt-5.6-sol,claude-sonnet-5)。
 *
 * ```bash
 * K2C_KEY=$(grep '^KIRO2CLAUDE_API_KEY=' .env | cut -d= -f2-) \
 *   node packages/core/test/manual/session-isolation-live.mjs
 * ```
 */

import { randomUUID } from 'node:crypto';
import { KEY, postJson, RESPONSES_PATH, reporter, responsesHeaders } from './_harness.mjs';

const CHAT_PATH = '/openai/v1/chat/completions';
const MODELS = (process.env.K2C_ISOLATION_MODELS ?? 'gpt-5.6-luna,gpt-5.6-sol,claude-sonnet-5')
  .split(',')
  .filter(Boolean);
const QUESTION =
  'Earlier in this conversation, did I give you a secret code word? If so, repeat it exactly. If not, reply exactly NONE.';

if (!KEY) {
  console.error('K2C_KEY missing');
  process.exit(1);
}

const report = reporter();

async function chat(model, messages, promptCacheKey) {
  const { status, raw } = await postJson(CHAT_PATH, responsesHeaders(), {
    model,
    messages,
    prompt_cache_key: promptCacheKey,
    max_tokens: 200,
  });
  const body = JSON.parse(raw);
  return {
    status,
    text: body.choices?.[0]?.message?.content ?? '',
    credits: body.usage?.kiro_metering?.usage,
  };
}

for (const model of MODELS) {
  const key = randomUUID();
  const nonce = `ZEBRA-${Math.floor(Math.random() * 9e5 + 1e5)}`;
  const a1 = [{ role: 'user', content: `The secret code word for this chat is ${nonce}. Reply only with OK.` }];
  const r1 = await chat(model, a1, key);
  const a2 = [
    ...a1,
    { role: 'assistant', content: r1.text },
    { role: 'user', content: 'Reply OK again to confirm you still have it.' },
  ];
  const r2 = await chat(model, a2, key);
  const b = await chat(model, [{ role: 'user', content: QUESTION }], key);
  const c = await chat(model, [...a2, { role: 'assistant', content: r2.text }, { role: 'user', content: QUESTION }], key);
  report.record(`${model} 同键新会话不串`, !b.text.includes(nonce), `B 答:${b.text.slice(0, 40)}`);
  report.record(`${model} 正对照能回忆`, c.text.includes(nonce), `C 答:${c.text.slice(0, 40)}`);
  if (model.startsWith('gpt-')) {
    report.record(
      `${model} 同键第二轮命中缓存`,
      r1.credits > 0 && r2.credits < r1.credits * 0.5,
      `credits ${r1.credits?.toFixed(4)} → ${r2.credits?.toFixed(4)}`,
    );
  }
}

const ROUNDTRIP_MODELS = [MODELS.find((m) => m.startsWith('gpt-')) ?? 'gpt-5.6-sol', 'claude-opus-5'];
for (const model of ROUNDTRIP_MODELS) {
  const key = randomUUID();
  const base = {
    model,
    prompt_cache_key: key,
    include: ['reasoning.encrypted_content'],
    reasoning: { effort: 'high' },
  };
  const q1 = [{ role: 'user', content: 'Is 391 prime? Think it through, then answer yes or no with the factorization.' }];
  const first = await postJson(RESPONSES_PATH, responsesHeaders(), { ...base, input: q1 });
  const output = JSON.parse(first.raw).output ?? [];
  const reasoning = output.filter((i) => i.type === 'reasoning' && i.encrypted_content);
  report.record(`${model} 下发推理信封`, reasoning.length > 0, `output=${output.map((i) => i.type)}`);
  const second = await postJson(RESPONSES_PATH, responsesHeaders(), {
    ...base,
    input: [...q1, ...output, { role: 'user', content: 'Now is 391 + 2 prime? Answer yes or no.' }],
  });
  const text = (JSON.parse(second.raw).output ?? [])
    .filter((i) => i.type === 'message')
    .flatMap((i) => i.content.map((p) => p.text))
    .join('');
  report.record(`${model} 回传信封上游照收`, second.status === 200 && text.length > 0, `status=${second.status} 答:${text.slice(0, 40)}`);
}

report.finish();
