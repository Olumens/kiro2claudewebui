/**
 * 上游缓存作用域探针(手工,💰 打真实上游,不进 CI)。缓存由 credits 反推:同尺寸冷请求为基准,
 * warm / cold 比值 ≈ 缓存价倍率即命中。场景:S1 同 id 续写、S2 同 id 插一段别的对话、S3 各用各的
 * id 交替、S4 同 id 插旁路小请求、S5 换 id 续写、S6 同 id 插 5 段、S7 同 id 同 acid 交替。
 * 结论见 PITFALLS「会话身份映射到 kiro-cli」的缓存作用域。`K2C_MODEL` 换模型,`K2C_ONLY=S1,S5`
 * 挑场景,`K2C_WORDS` 调前缀长度;结果追加到 /tmp/k2c-identity/interleave.jsonl。
 *
 * ```bash
 * cd packages/core && npx tsx --env-file-if-exists=../../.env test/manual/cache-scope-probe.ts
 * ```
 */

import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { eventFromFrame } from '../../src/kiro/model/events/base.js';
import { parseFrame } from '../../src/kiro/parser/frame.js';
import { seededDoc } from './_harness.mjs';
import { createRealUpstream } from './_real-provider.js';

type Obj = Record<string, unknown>;
const { provider } = createRealUpstream();
const OUT = '/tmp/k2c-identity/interleave.jsonl';
mkdirSync('/tmp/k2c-identity', { recursive: true });

interface Result {
  status: number | string;
  text: string;
  credits?: number;
  ctxPct?: number;
}

async function send(body: Obj): Promise<Result> {
  const s: Result = { status: 0, text: '' };
  try {
    const res = await provider.callApiStream(JSON.stringify(body));
    s.status = res.status;
    const chunks: Buffer[] = [];
    for await (const c of res.data as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
    let buf = Buffer.concat(chunks);
    while (buf.length) {
      const r = parseFrame(buf);
      if (!r) break;
      buf = buf.subarray(r.consumed);
      const ev = eventFromFrame(r.frame);
      if (ev.kind === 'AssistantResponse') s.text += ev.content;
      if (ev.kind === 'Metering') s.credits = ev.usage;
      if (ev.kind === 'ContextUsage') s.ctxPct = ev.contextUsagePercentage;
    }
  } catch (e) {
    s.status = `error:${(e as Error).message.slice(0, 200)}`;
  }
  return s;
}

const MODEL = process.env.K2C_MODEL ?? 'gpt-5.6-luna';
const isGpt = MODEL.startsWith('gpt');
const WORDS = Number(process.env.K2C_WORDS ?? 4000);
const RUN = randomUUID().slice(0, 8);

const user = (content: string) => ({
  userInputMessage: { content, modelId: MODEL, origin: 'AI_EDITOR' },
});
const asst = (content: string) => ({ assistantResponseMessage: { content } });

function body(conv: string, history: Obj[], current: string): Obj {
  return {
    conversationState: {
      conversationId: conv,
      rootConversationId: conv,
      agentContinuationId: randomUUID(),
      agentTaskType: 'vibe',
      chatTriggerType: 'MANUAL',
      currentMessage: user(current),
      ...(history.length ? { history } : {}),
    },
    agentMode: 'vibe',
    additionalModelRequestFields: isGpt
      ? { reasoning: { effort: 'none' } }
      : { thinking: { type: 'disabled' } },
  };
}

const ASK = 'Reply with exactly: OK';
/** 第一轮:大前缀 + 问题 */
const turn1 = (conv: string, doc: string) => body(conv, [], `${doc}\n\n${ASK}`);
/** 第二轮:把第一轮放进 history 再问一次(前缀 = 第一轮的全部上下文) */
const turn2 = (conv: string, doc: string) =>
  body(conv, [user(`${doc}\n\n${ASK}`), asst('OK')], 'Reply with exactly: OK AGAIN');
const tiny = (conv: string) => body(conv, [], 'Reply with exactly: TITLE');

async function step(scenario: string, label: string, b: Obj): Promise<Result> {
  const r = await send(b);
  const rec = {
    run: RUN,
    model: MODEL,
    scenario,
    label,
    status: r.status,
    credits: r.credits,
    ctxPct: r.ctxPct,
    text: r.text.slice(0, 40),
  };
  appendFileSync(OUT, `${JSON.stringify(rec)}\n`);
  console.log(JSON.stringify(rec));
  return r;
}

const sid = () => `sess_${randomUUID()}`;
let seed = Number.parseInt(RUN.slice(0, 6), 16);
const doc = () => seededDoc(WORDS, ++seed);

const ONLY = new Set((process.env.K2C_ONLY ?? 'S1,S2,S3,S4,S5').split(','));

// S1 对照:同 id,A1 → A2
if (ONLY.has('S1')) {
  const id = sid();
  const A = doc();
  await step('S1-same-id', 'A1', turn1(id, A));
  await step('S1-same-id', 'A2', turn2(id, A));
}
// S2 交替:同 id,A1 → B1 → A2
if (ONLY.has('S2')) {
  const id = sid();
  const A = doc();
  const B = doc();
  await step('S2-interleave-same-id', 'A1', turn1(id, A));
  await step('S2-interleave-same-id', 'B1', turn1(id, B));
  await step('S2-interleave-same-id', 'A2', turn2(id, A));
}
// S3 分 id 交替:idA A1 → idB B1 → idA A2
if (ONLY.has('S3')) {
  const idA = sid();
  const idB = sid();
  const A = doc();
  const B = doc();
  await step('S3-interleave-own-ids', 'A1', turn1(idA, A));
  await step('S3-interleave-own-ids', 'B1', turn1(idB, B));
  await step('S3-interleave-own-ids', 'A2', turn2(idA, A));
}
// S4 旁路小请求:同 id,A1 → tiny → A2
if (ONLY.has('S4')) {
  const id = sid();
  const A = doc();
  await step('S4-side-request-same-id', 'A1', turn1(id, A));
  await step('S4-side-request-same-id', 'tiny', tiny(id));
  await step('S4-side-request-same-id', 'A2', turn2(id, A));
}
// S5 跨 id:idP A1 → idQ A2
if (ONLY.has('S5')) {
  const A = doc();
  await step('S5-cross-id', 'A1', turn1(sid(), A));
  await step('S5-cross-id', 'A2', turn2(sid(), A));
}
// S6 容量:同 id,A1 → 5 段别的对话 → A2
if (ONLY.has('S6')) {
  const id = sid();
  const A = doc();
  await step('S6-five-interleaved-same-id', 'A1', turn1(id, A));
  for (let i = 1; i <= 5; i++) await step('S6-five-interleaved-same-id', `B${i}`, turn1(id, doc()));
  await step('S6-five-interleaved-same-id', 'A2', turn2(id, A));
}
// S7 acid 相撞:同 id、同 acid,A1 → B1 → A2
if (ONLY.has('S7')) {
  const id = sid();
  const acid = randomUUID();
  const withAcid = (b: Obj) => {
    (b.conversationState as Obj).agentContinuationId = acid;
    return b;
  };
  const A = doc();
  const B = doc();
  await step('S7-same-id-same-acid', 'A1', withAcid(turn1(id, A)));
  await step('S7-same-id-same-acid', 'B1', withAcid(turn1(id, B)));
  await step('S7-same-id-same-acid', 'A2', withAcid(turn2(id, A)));
}
