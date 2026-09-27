/**
 * Claude 模型的 credit 费率与缓存折扣探针(手工,💰 打真实上游,不进 CI)。新 Claude 模型接入 derived
 * 反演前用它标定,结论见 PITFALLS「支持哪些模型」。
 *
 * - models(免费):上游 `ListAvailableModels` 里这些模型的倍率、token 上限与 thinking / effort schema
 * - wire:thinking disabled 是否被拒、默认与 summarized 时的 reasoning 帧(`K2C_WIRE_MODEL`)
 * - 输入斜率:同一模型两种前缀长度的冷请求,credits 差 ÷ token 差;跨模型比斜率即相对费率
 * - 缓存:同前缀第二轮(history 带第一轮)对冷请求的 credits,按斜率折算命中价倍率
 * - 输出:数到 N_S / N_L 的差分,credits 差 ÷ token 差
 *
 * 全部走 adaptive + effort low + omitted(thinking 不可关的模型也能同口径比);常数项(输出、
 * 推理、上游自带前缀)在斜率里抵消。`K2C_MODELS` 逗号分隔(上游 id),`K2C_REPS` 重复轮数,
 * `K2C_ONLY=models,wire,input,suffix,output` 挑阶段;结果追加到 /tmp/k2c-rate/rate.jsonl。记录里没有 credits
 * 的多半是上游 `CONTENT_FILTERED`(sonnet-5 对 ≥30K 的随机串文档会拦,不计费),调小 `K2C_WORDS_*` 重跑。
 *
 * ```bash
 * cd packages/core && npx tsx --env-file-if-exists=../../.env test/manual/claude-rate-probe.ts
 * ```
 */

import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { resolveContextUsage } from '../../src/claude/converter.js';
import { getKiroClientProfile, requireKasTarget } from '../../src/kiro/client-profile.js';
import { credentialEffectiveApiRegion } from '../../src/kiro/model/credentials.js';
import { type Event, eventFromFrame } from '../../src/kiro/model/events/base.js';
import { parseFrame } from '../../src/kiro/parser/frame.js';
import { seededDoc } from './_harness.mjs';
import { createRealUpstream } from './_real-provider.js';

type Obj = Record<string, unknown>;
const { provider, tokenManager } = createRealUpstream();
const kasBody = getKiroClientProfile().kas.body;
const OUT_DIR = '/tmp/k2c-rate';
const OUT = `${OUT_DIR}/rate.jsonl`;
mkdirSync(OUT_DIR, { recursive: true });

interface Result {
  status: number | string;
  text: string;
  credits?: number;
  ctxPct?: number;
  /** 上游 `metadataEvent.stopReason`;缺 credits 时看它(如 `CONTENT_FILTERED`) */
  stopReason?: string;
  error?: string;
  reasoningFrames: number;
  reasoningChars: number;
  signatures: number;
}

async function send(body: Obj): Promise<Result> {
  const s: Result = { status: 0, text: '', reasoningFrames: 0, reasoningChars: 0, signatures: 0 };
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
      let ev: Event;
      try {
        ev = eventFromFrame(r.frame);
      } catch {
        continue;
      }
      if (ev.kind === 'AssistantResponse') s.text += ev.content;
      if (ev.kind === 'Metadata') s.stopReason = ev.stopReason;
      if (ev.kind === 'Error' || ev.kind === 'Exception')
        s.error = JSON.stringify(ev).slice(0, 300);
      if (ev.kind === 'Metering') s.credits = ev.usage;
      if (ev.kind === 'ContextUsage') s.ctxPct = ev.contextUsagePercentage;
      if (ev.kind === 'ReasoningContent') {
        s.reasoningFrames++;
        s.reasoningChars += ev.text?.length ?? 0;
        if (ev.signature) s.signatures++;
      }
    }
  } catch (e) {
    s.status = `error:${(e as Error).message.slice(0, 300)}`;
  }
  return s;
}

const MODELS = (process.env.K2C_MODELS ?? 'claude-opus-5,claude-opus-5.5').split(',');
const WIRE_MODEL = process.env.K2C_WIRE_MODEL ?? MODELS[MODELS.length - 1] ?? 'claude-opus-5.5';
const REPS = Number(process.env.K2C_REPS ?? 2);
const WORDS_S = Number(process.env.K2C_WORDS_S ?? 3000);
const WORDS_L = Number(process.env.K2C_WORDS_L ?? 12000);
const N_S = Number(process.env.K2C_N_S ?? 100);
const N_L = Number(process.env.K2C_N_L ?? 500);
const ONLY = new Set((process.env.K2C_ONLY ?? 'models,wire,input,suffix,output').split(','));
const RUN = randomUUID().slice(0, 8);

const LOW = {
  thinking: { type: 'adaptive', display: 'omitted' },
  output_config: { effort: 'low' },
};

const user = (model: string, content: string) => ({
  userInputMessage: { content, modelId: model, origin: kasBody.origin },
});
const asst = (content: string) => ({ assistantResponseMessage: { content } });

function body(model: string, history: Obj[], current: string, fields: Obj | undefined): Obj {
  const conv = `sess_${randomUUID()}`;
  return {
    conversationState: {
      conversationId: conv,
      rootConversationId: conv,
      agentContinuationId: randomUUID(),
      agentTaskType: kasBody.agentTaskType,
      chatTriggerType: kasBody.chatTriggerType,
      currentMessage: user(model, current),
      ...(history.length ? { history } : {}),
    },
    agentMode: kasBody.agentMode,
    ...(fields ? { additionalModelRequestFields: fields } : {}),
  };
}

async function step(phase: string, model: string, label: string, b: Obj): Promise<Result> {
  const r = await send(b);
  const rec = {
    run: RUN,
    phase,
    model,
    label,
    status: r.status,
    credits: r.credits,
    ctxPct: r.ctxPct,
    // 与网关喂给 derived 的 kiro.inputTokens 同一换算
    tokens: r.ctxPct === undefined ? undefined : resolveContextUsage(model, r.ctxPct).inputTokens,
    stopReason: r.stopReason,
    error: r.error,
    reasoningFrames: r.reasoningFrames,
    reasoningChars: r.reasoningChars,
    signatures: r.signatures,
    text: r.text.slice(0, 60),
  };
  appendFileSync(OUT, `${JSON.stringify(rec)}\n`);
  console.log(JSON.stringify(rec));
  return r;
}

let seed = Number.parseInt(RUN.slice(0, 6), 16);
const ASK = 'Reply with exactly: OK';

// KAS 的控制面在 management.{region}.kiro.dev(runtime / codewhisperer 两个 host 都不认这个 target)
if (ONLY.has('models')) {
  const { credentials, token } = await tokenManager.acquireContext();
  const profile = getKiroClientProfile();
  const region = credentialEffectiveApiRegion(credentials, tokenManager.config());
  const res = await fetch(`https://management.${region}.kiro.dev/`, {
    method: 'POST',
    headers: {
      ...profile.kas.staticHeaders,
      'x-amz-target': requireKasTarget(profile, 'listAvailableModels'),
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      origin: kasBody.origin,
      ...(credentials.profileArn ? { profileArn: credentials.profileArn } : {}),
    }),
  });
  const { models } = (await res.json()) as { models: Obj[] };
  for (const m of models.filter((x) => MODELS.includes(String(x.modelId)))) {
    const { modelId, rateMultiplier, tokenLimits, promptCaching } = m;
    const schema = m.additionalModelRequestFieldsSchema;
    console.log(JSON.stringify({ modelId, rateMultiplier, tokenLimits, promptCaching, schema }));
  }
}

if (ONLY.has('wire')) {
  const m = WIRE_MODEL;
  await step('wire', m, 'disabled', body(m, [], ASK, { thinking: { type: 'disabled' } }));
  await step('wire', m, 'no-fields', body(m, [], ASK, undefined));
  await step(
    'wire',
    m,
    'summarized-low',
    body(m, [], 'What is 17 * 23? Answer with the number only.', {
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'low' },
    }),
  );
}

if (ONLY.has('input')) {
  for (let rep = 1; rep <= REPS; rep++) {
    for (const m of MODELS) {
      const S = seededDoc(WORDS_S, ++seed);
      const L = seededDoc(WORDS_L, ++seed);
      await step('input', m, `cold-S#${rep}`, body(m, [], `${S}\n\n${ASK}`, LOW));
      await step('input', m, `cold-L#${rep}`, body(m, [], `${L}\n\n${ASK}`, LOW));
      await step(
        'input',
        m,
        `warm-L#${rep}`,
        body(m, [user(m, `${L}\n\n${ASK}`), asst('OK')], 'Reply with exactly: OK AGAIN', LOW),
      );
    }
  }
}

// 稳态会话的形状:命中前缀 + 一段新内容。新内容对 warm-L 的 credits 差 ÷ token 差 = 追加内容的单价;
// cold-M 是第三个冷尺寸,验证冷价线性。
if (ONLY.has('suffix')) {
  for (const m of MODELS) {
    const L = seededDoc(WORDS_L, ++seed);
    const M = seededDoc(WORDS_S, ++seed);
    const hist = [user(m, `${L}\n\n${ASK}`), asst('OK')];
    await step(
      'suffix',
      m,
      'cold-M',
      body(m, [], `${seededDoc(WORDS_S * 2, ++seed)}\n\n${ASK}`, LOW),
    );
    await step('suffix', m, 'cold-L', body(m, [], `${L}\n\n${ASK}`, LOW));
    await step('suffix', m, 'warm-L', body(m, hist, 'Reply with exactly: OK AGAIN', LOW));
    await step('suffix', m, 'warm-L+new', body(m, hist, `${M}\n\n${ASK}`, LOW));
  }
}

if (ONLY.has('output')) {
  const count = (n: number) =>
    `Output the integers from 1 to ${n} in order, separated by single spaces. Output nothing else.`;
  for (const m of MODELS) {
    await step('output', m, `count-${N_S}`, body(m, [], count(N_S), LOW));
    await step('output', m, `count-${N_L}`, body(m, [], count(N_L), LOW));
  }
}
