# 编写 kiro2claude 插件

插件在不改动 core 的前提下,为 kiro2claude 网关扩展额外路由与 wire 字段变更。契约由 [`@kiro2claude/plugin-api`](../packages/plugin-api/) 提供。

> 本项目不发布到 npm。获取契约的方式:clone 本仓库后在其 pnpm workspace 内开发(依赖写 `"@kiro2claude/plugin-api": "workspace:*"`),或参照 `packages/plugin-api/` 的契约类型自行实现。

## 快速上手

在 workspace 内新建你的插件包:

```jsonc
// packages/my-plugin/package.json
{
  "name": "my-plugin",
  "type": "module",
  "main": "./dist/index.js",
  "exports": { ".": { "import": "./dist/index.js" } },
  "scripts": { "build": "tsc -p tsconfig.json" },
  "keywords": ["kiro2claude-plugin"],
  "dependencies": {
    "@kiro2claude/plugin-api": "workspace:*"
  },
  "peerDependencies": {
    "fastify": "^5.0.0"
  }
}
```

```ts
// src/index.ts
import { BasePlugin, type PluginContext } from '@kiro2claude/plugin-api';

class MyPlugin extends BasePlugin {
  readonly name = 'my-plugin';
  readonly version = '1.0.0';

  register(ctx: PluginContext) {
    ctx.app.get('/my-route', async () => ({ ok: true }));

    ctx.registerHook.onUsageFinish((event) => {
      event.addExtension('my_namespace', { model: event.model });
    });
  }
}

export default new MyPlugin();
```

再把它加进 `packages/core/package.json` 的 `dependencies`(`"my-plugin": "workspace:*"`)、`pnpm install`、build。loader 经包名 `import`,入口取 `exports` / `main`,没 build 就加载不到(失败只打 warn,见下节)。

## 发现机制

core 启动时只扫描 core 所在的那一个 `node_modules`(开发态 `packages/core/node_modules`,镜像 `/app/node_modules`)的第一层与 `@scope/` 下一层,不递归;`package.json` 带 `kiro2claude-plugin` keyword 的包按包名 `import`。内置插件(`metering` / `derived`)是 `@kiro2claude/core` 的依赖,走同一条路径被发现,与第三方插件无区别。`KIRO2CLAUDE_PLUGIN_ROOT` 可以换扫描根,但 `import` 仍从 core 自身的位置解析,插件包必须装在 core 解析得到的 `node_modules` 里。

失败隔离到单个插件:import 失败、没有合法默认导出、`apiVersion` 不符、`register()` 抛错,都是打 warn、跳过该插件、其余照常,core 自身的路由始终可用。三个例外:

- `dependsOn` 成环:整次发现失败,打 error,**所有**插件(含内置)都不加载
- `dependsOn` 指向没被发现的插件:只打 warn,依赖方照常加载
- `register()` 中途抛错:抛错前已注册的 hook / 路由不回滚

## 契约面

### Manifest

```ts
interface KiroPlugin {
  readonly name: string;          // 'my-plugin' —— 小写 kebab
  readonly version: string;       // '1.0.0'
  readonly apiVersion: '1.x';     // 必须声明 '1.x' 以接入 1.x host 线
  readonly dependsOn?: readonly string[];   // run-after 约束,拓扑排序
  register(ctx: PluginContext): Promise<void> | void;
}
```

继承 `BasePlugin` 可省去 apiVersion 样板。

### Context

```ts
interface PluginContext {
  readonly app: FastifyInstance;
  readonly logger: PluginLogger;
  readonly env: NodeJS.ProcessEnv;
  readonly apiKey: string;
  readonly registerHook: HookRegistrar;
  getCapability<T = unknown>(name: string): T | undefined;
}
```

### Capability(能力)

Capability 是 host 在不暴露内部类型的前提下提供的命名服务。按字符串名查询,消费方自行校验形状。

| Capability 名 | 形状 | 提供方 |
|---|---|---|
| `'usage-limits'` | `UsageLimitsProvider`(`getUsageLimits(): Promise<UsageSnapshot>`) | core |

### Hooks(钩子)

```ts
interface HookRegistrar {
  onUsageFinish(handler: (event: UsageFinishEvent) => void | Promise<void>): void;
}
```

`onUsageFinish` 在每次上游响应结束时至多触发一次,在 core 写出 wire usage 之前,插件可读取 meta 键并改写 usage。上游中途报错时,只要已经收到计量帧(流式另含已向客户端提交的情况)也会触发,好让计量插件记账,此时的改写不会上 wire。多个插件按注册顺序(`dependsOn` 拓扑序)依次执行;handler 抛错由 host 捕获,打 warn 后跳过,不影响响应。

### Meta 键

core 把这些约定键写入每个 `UsageFinishEvent`。插件用 `event.getMeta(key)` 读取:

| 键 | 类型 | 说明 |
|---|---|---|
| `kiro.inputTokens` | number | 最终输入 token 数:上游 contextUsage 还原值(含本轮输出),拿不到时为本地估算,见 `event.inputTokensSource` |
| `kiro.outputTokens` | number | 可见输出的本地估算 |
| `kiro.creditsUsed` | number? | 上游 `meteringEvent` 帧的 `usage`(credit) |
| `kiro.pricedModel` | string | 上游实际计费的模型 id(core `mapModel` 映射后,如 `claude-opus-4.6` / `gpt-5.6-sol`);客户端原名见 `event.model` |
| `kiro.upstreamRaw` | unknown? | 完整上游计量 payload,给高级插件 |
| `kiro.meteringMissing` | boolean | 上游**已扣费**但计量帧没到 → `creditsUsed` 为空却确实花了钱 |

`?` 表示**值**可能是 `undefined`,不表示键会缺席。

这张表就是契约本身:core 侧有静态守卫(`packages/core/test/static/usage-meta-contract.test.ts`)把它与实际写入的键钉在一起,表里没有的键 core 不会产出。

**`kiro.meteringMissing` 怎么用**:`creditsUsed` 为空有两种成因——真·空响应(本就没有 credit,静默跳过是对的)与「上游算了账、网关没收到账单」。只有后者是漏账,这个键把两者分开。⚠ 它度量的是「有产出但没拿到计量帧」,并**不等于**「有 credit 没记账」的全集,口径偏差(哪些情况多报、哪些漏报)见 core 侧 `isMeteringLost` 的头注释。

**`event.listMetaKeys()`** 返回本次事件上所有已填充的键。⚠ **有键 ≠ 有值**:core 每次都会写入全部约定键,读不到数据时表现为**值**是 `undefined`,而不是键消失。判断可用性一律用 `getMeta(k) === undefined`,不要用 `listMetaKeys().includes(k)`——后者恒为真。`listMetaKeys()` 的用途是调试,以及探测更高版本 host 新增的键。

### Wire 改写

两个语义不同的 API,按意图选用:

```ts
// 给 usage payload 加一个带命名空间的扩展字段。
// host 不裁决归属:同一 namespace 多次写入(含不同插件)后写覆盖,请用插件专属或厂商前缀的名字。
// 与 usage 已有字段同名(input_tokens、OpenAI 的 prompt_tokens_details 等)的 namespace 被忽略。
event.addExtension('my_namespace', { /* ... */ });

// 覆写一个 Anthropic 标准 usage 字段,改标准字段只能走这里。
// 若两个插件覆写同一字段,host 打 warn 日志(带双方的 reason)。
event.overrideStandardField('input_tokens', 1234, 'reason for override');
```

`StandardUsageField` 为 `'input_tokens' | 'output_tokens' | 'cache_creation_input_tokens' | 'cache_read_input_tokens'`。

### 来源感知

`event.source` 标识网关路径,当前恒为:

- `'http-direct'` —— HTTP 直发路径(Claude 与 OpenAI 两个协议的端点都是)

OpenAI 端点并入 `addExtension` 的扩展;`overrideStandardField` 只取 `cache_read_input_tokens`,夹到 `[0, 输入总量]` 后映射成 `cached_tokens`(Chat `prompt_tokens_details`、Responses `input_tokens_details`),其余覆写不套(`prompt_tokens` 语义是输入总量,缓存是它的子集);`/api/*` 去泄漏镜像照常触发 hook,扩展字段不上 wire,`cached_tokens` 是标准字段、照常保留。

`event.inputTokensSource` 报告输入 token 的可靠性:

- `'client-estimate'` —— 对 wire 请求体做的本地分词估算
- `'upstream-reported'` —— 来自上游的权威计数

## 契约的版本管理

`@kiro2claude/plugin-api` 遵循 semver。插件声明 `apiVersion: '1.x'` 以接入整条 1.x 线。host 注册前用 `assertApiVersion` 校验,只接受字面量 `'1.x'`,其它取值跳过该插件。

当 2.0 落地(破坏性变更)时,适配后把插件的 `apiVersion` 改为 `'2.x'`。

## 示例

- [`packages/examples/echo-plugin/`](../packages/examples/echo-plugin) —— 最小契约示范
- first-party 企业插件在闭源仓,但同样基于这套契约编写。

## 许可证

`@kiro2claude/plugin-api` 本身是 MIT,所以你的插件(即便闭源)可自由依赖它。
