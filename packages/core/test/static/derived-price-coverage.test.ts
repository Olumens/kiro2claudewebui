/**
 * 守卫:catalog 里每个模型,在内置 derived 插件里都能按上游 id 定价。
 *
 * 加模型要同改的表分散在 core 与 derived 两个包里(清单见 PITFALLS「支持哪些模型」),其中漏了
 * derived 价格表不会让任何请求失败,只会让该模型永远 `unknown_model`、缓存命中恒报 0。插件不能
 * import core,所以这条跨包核对放在 core 侧:走与线上相同的路径(`kiro.pricedModel` = `mapModel`
 * 结果)喂给 `deriveKiroUsage`。
 */

import { describe, expect, it } from 'vitest';
import { deriveKiroUsage } from '../../../plugin-derived/src/derive.js';
import { mapModel } from '../../src/claude/converter.js';
import { MODELS } from '../../src/claude/models-catalog.js';

describe('catalog ↔ derived 价格表', () => {
  it('每个 catalog 模型的上游 id 都不落 unknown_model', () => {
    const upstreamIds = new Set(MODELS.map(({ id }) => mapModel(id)));
    expect(upstreamIds.has(undefined)).toBe(false);
    for (const id of upstreamIds) {
      const status = deriveKiroUsage(id as string, 50_000, 10, 0.1).derived.derivedStatus;
      expect(status, id).not.toBe('unknown_model');
    }
  });
});
