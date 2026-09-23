/**
 * Static guard: the upstream wire is kiro-cli V3 (KAS) only.
 *
 * 网关只模拟 kiro-cli `chat --v3`(KAS)一套 wire(见 PITFALLS「kiro-cli V3(KAS)的 wire」)。
 * V2(Rust 引擎)的专属形态一旦回流,上游看到的就是两套客户端拼出来的请求——没有任何真实
 * 客户端这样发。这里扫描去掉注释后的 `src/`,钉死这些 V2 遗留不再出现:
 *   - target `AmazonCodeWhispererStreamingService.*`、UA service `codewhispererstreaming`
 *   - REST 路径 `…kiro.dev/generateAssistantResponse` / `…kiro.dev/mcp`
 *   - body 的 `origin: 'KIRO_CLI'`、`envState`、assistant 的 `messageId`
 * GetUsageLimits 仍由 kiro-cli 的 Rust 外壳发,它的 `AmazonCodeWhispererService` target 不在此列。
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SRC_ROOT, stripComments, walkTsFiles } from '../helpers/static-scan.js';

/** 上游 body 的构造点;`messageId` 只在这里查(SSE 响应自己也有同名的 `msg_…` id)。 */
const isWireBodyBuilder = (rel: string) =>
  rel.startsWith(path.join('kiro', 'model', 'requests')) ||
  rel === path.join('claude', 'converter.ts');

const FORBIDDEN: Array<[string, RegExp, (rel: string) => boolean]> = [
  ['V2 streaming target', /AmazonCodeWhispererStreamingService/, () => true],
  ['V2 UA service id', /codewhispererstreaming/, () => true],
  ['V2 REST paths', /kiro\.dev\/(generateAssistantResponse|mcp)\b/, () => true],
  ['V2 origin', /['"]KIRO_CLI['"]/, () => true],
  ['V2 envState', /\benvState\b/, () => true],
  ['V2 assistant messageId', /\bmessageId\b/, isWireBodyBuilder],
];

describe('upstream wire is kiro-cli V3 only', () => {
  const files = walkTsFiles(SRC_ROOT);

  it('scans a non-trivial set of source files', () => {
    expect(files.length).toBeGreaterThan(40);
  });

  for (const [label, pattern, inScope] of FORBIDDEN) {
    it(`no ${label} in src/`, () => {
      const hits = files
        .map((f) => path.relative(SRC_ROOT, f))
        .filter(inScope)
        .filter((rel) =>
          pattern.test(stripComments(fs.readFileSync(path.join(SRC_ROOT, rel), 'utf8'))),
        );
      expect(hits).toEqual([]);
    });
  }

  it('the messageId scope still covers the wire body builders', () => {
    expect(
      files.map((f) => path.relative(SRC_ROOT, f)).filter(isWireBodyBuilder).length,
    ).toBeGreaterThan(2);
  });
});
