# dshx-token-cost

一个 DSH 设置页插件，回答两个问题：

1. **账户里还剩多少钱** —— 直接读 DeepSeek 平台接口；
2. **这台机器每天、每个模型烧了多少 token，按 API 牌价折算是多少钱** —— 读本机会话日志。

设置 → **用量与费用**。

> v2.0.0 把原来的「账户余额」插件（`dshx-usage-panel`）合并了进来，并重写了取数层。
> 旧版用 harness 的 `sessionQuery` 服务读日志，每次调用都要重放校验整份日志（约 0.2 s/会话），
> 250 个会话要 50–90 秒，页面一直卡在「读取中」。现在直接解 zstd 读日志 + 持久化索引，
> 冷启动约 2.5 秒，之后每次刷新在毫秒级。

## 它回答什么

| 问题 | 面板里的位置 |
|---|---|
| 账户还剩多少？ | 顶部「账户余额」卡片 |
| 这段时间花了多少钱？ | 区间汇总 → 估算费用 |
| 哪一天最贵？ | 每日用量表（点任意一行展开当天的模型明细） |
| 哪个模型在吃预算？ | 按模型汇总表 |
| 缓存命中了多少？ | 区间汇总 → 缓存命中率 |
| 缓存读写了多少？ | 每日用量 →「缓存读写」合计列（悬停看读写拆分）；按模型汇总 →「缓存读」「缓存写」分列 |
| 同一个模型走了几条 provider 路由？ | 模型名后的「N 条路由」标签（悬停看详情） |
| 每小时烧了多少 token、值多少钱？ | 「按小时用量」图表（v2.1.0） |

### 按小时用量（v2.1.0）

区间汇总下方的图表卡片，柱子是 token 量（深色 = 输入 + 输出 + 缓存写，浅色 = 缓存读，
分开堆叠是因为缓存读量大但便宜，混在一起会让「量大但不贵」的小时看起来很贵），
橙色折线是该小时的估算费用（右轴，跟随所选货币）。悬停任意柱子看该小时的明细与前 4 个模型。

- **时间线**：区间内逐小时排开（空闲小时留空），可横向滚动，默认滚到最新；最多显示最近 31 天。
- **24 小时分布**：把整个区间折叠到 0–23 点，看一天中哪个时段花得最多（悬停显示日均）。
- 顶部四个指标：最贵的一小时、单小时最多 token、活跃小时均值、活跃小时数。

小时按**本机时区**的钟点归桶，与日期列一致；每小时按模型分别计价后求和，
所以一天的各小时之和恰好等于当天的费用（端点测试断言了这一点）。
视图选择也记在 `dshx-token-cost/prefs` 里。

索引里每个会话多存了一份 `hours`（`INDEX_VERSION` 升到 4），升级后第一次启动会整体重建一次索引（约数秒）。
端点返回新增 `usage.hours`（只含有调用的小时，旧→新）与 `usage.hoursAvailable`。

区间可选 **当月 / 当天 / 7 / 14 / 30 / 90 天**，或点「自定义」用两个日期选择器指定任意起止日期
（最长 365 天）。货币可切 ¥ / $，单独一行。

「当天」就是一个单日窗口（`days=1`），host 本来就支持，所以只是多了个标签。

**「当月」是日历月，不是 30 天**：每月 1 号到月末的**整月**，所以 2 月是 28 或 29 天、
4 月是 30 天——数字随月份变，这正是它和「30 天」的区别。它存的是**选择本身**
（`{"kind":"month"}`）而不是某次的起止日期，因此下个月打开仍是「当月」，不会被冻在上个月。
host 本来就接受 `from`/`to`，所以它发的是 `from=<1 号>&to=<月末>`，**取数层零改动**。
状态行回显该区间实际覆盖的日期（`2026-10-01 → 2026-10-31（31 天）`）——
「整月」到底算了哪几天不该让人猜。
月末用「下个月的第 0 天」求得，不需要 28/29/30/31 的表，闰年自动正确；
全部走本地时间，看到的是读者所在月份。

自定义区间会自动以当前窗口为初值，避免点开就是空表单；区间不完整时**不发请求**，
继续显示上一次的结果，而不是悄悄换成一个别的窗口。

**区间和货币会被记住**，存在 `localStorage` 的 `dshx-token-cost/prefs` 里，
下次打开设置页直接沿用上次的选择（预设区间、自定义起止日期、计价货币都记）。
存储不可用时（被策略禁用等）静默回落到默认值（30 天 / 人民币），不会影响页面。
旧版本存的裸 `days` 数字会被迁移过来，不会因为升级而丢失选择。

**账户余额那一栏也跟随计价货币**：平台的余额接口是**每个币种钱包一条记录**，
且**不保证顺序稳定**（实测连续三次调用返回 `USD,CNY` → `CNY,USD` → `USD,CNY`），
所以插件按所选币种**挑对应的那条钱包**，而不是取第一条。

这里**不做换算**——两个钱包是独立的余额，不是同一笔钱的不同写法
（本机账户同时有 `21.08 USD` 和 `0.61 CNY`）。所选币种没有对应钱包时，
就原样显示第一条。非主显示的钱包列在下方「另有 …」一行。

## 费用是怎么算出来的

**不是账单，是估算。** 依据是各厂商公开的 API 牌价：

```
费用 = 输入 × 输入价 + 输出 × 输出价
     + 缓存读 × 缓存读价 + 缓存写 × 缓存写价
```

四个桶是**互斥**的：日志里的 `inputTokens` 只记未命中缓存的输入
（实测一次调用 `inputTokens: 2` 而 `cacheReadTokens: 71000`），所以四项分别计价不会重复收费。
`reasoningTokens` 不计入合计，因为它是 `outputTokens` 的子集。

因此每日用量表里 **`输入 + 输出 + 缓存读写 = 合计`** 是恒等式——
「缓存读写」是缓存读与缓存写的和，写成合计列反而更便于按天比较；
需要看读写拆分时看按模型汇总表，那里两列是分开的。

单位为美元 / 百万 token，人民币按**实时汇率**折算（见下方「汇率」）。

**以人民币定价的模型按其公布的人民币价目计**。DeepSeek、智谱的官方价目是人民币
（如 DeepSeek V4 Pro 空闲价 ¥4.5 / ¥13.5），所以 `pricing.js` 里这类规则写的是
`cny(4.5)` 而不是折好的美元数——否则等于把写文件那天的汇率永久冻进价目表，
显示出来的人民币金额会变成 ¥4.25 这种厂商并不收取的数。报价与显示用同一个汇率换算，
往返精确。其余厂商（Anthropic、OpenAI、Google、xAI、Moonshot）以美元定价，直接跟随汇率。

口径说明：

- **DeepSeek 统一按空闲时段价计**。它的高峰时段（工作日 09:00–12:00、14:00–18:00）是空闲价的 2 倍，插件不区分时段，所以对白天使用的估算是**偏低**的。
- **Gemini 3.6 / 3.7 / 3.8 Flash 用当前 introductory 价**，官方计划 2027-01-01 翻倍。
- **同一模型走多条路由合并成一行**。你的配置里有 `transfer2`、`ki`、`grok-tran` 等自建网关，同一个 Claude Opus 5 可能从好几个 provider id 进来——它们是同一个产品，token 单价一样，所以合并统计；行尾的「N 条路由」标出实际经过了几条。
- 价目表核对于 `2026-10-11`，卡片底部会显示这个日期。

## 汇率

美元兑人民币的汇率**每天自动更新一次**，取自两个公开接口，按顺序尝试：

| 来源 | 接口 | 数据 |
|---|---|---|
| `er-api` | `open.er-api.com/v6/latest/USD` | exchangerate-api.com |
| `frankfurter` | `api.frankfurter.app/latest?from=USD&to=CNY` | 欧洲央行参考汇率 |

选两个**上游数据不同**的来源而不是同一份数据的两个镜像——两者一致才有意义。
拿到结果后缓存在 `~/.dsh/dshx-token-cost/rate.json`，24 小时内不再请求；
`force=1`（点「重新统计」）会强制刷新。

失败时的降级顺序是：**上次已知汇率 → 内置默认值 `7.1`**。
保留上次的汇率是有意的——一天前的真实汇率也比一个过时的常量更有用；
只有在从未成功获取过时才会用内置值，此时卡片底部会明确标注并提示可能偏差。

插件**不会为了刷新汇率而自己定时唤醒**：只有面板请求时才按需刷新，
一个没人看的时候还在发网络请求的插件不是好邻居。

汇率是否可信也做了校验：响应必须是可解析的 JSON、必须带 `rates.CNY`，
且结果要落在 `2–20` 这个区间内——超出这个范围说明接口返回了占位值、
换了基准货币或返回了错误页，**宁可不用也不能显示**，否则整个面板的金额都会被带偏。

## token 是怎么统计的

读会话日志（`~/.dsh/sessions`），不碰任何凭据。每条模型调用在日志里留有两种事件：

```
request/header     带 data.header.config.{provider, model}
assistant/message  带 data.usage.{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens}
```

`request/header` 描述的是**紧跟其后**的那次调用，所以插件按日志顺序走，记住最近的 provider/model，
把之后每条带 usage 的消息都归给它。实测 248 个会话、10,078 条带 usage 的消息，**归属率 100%**。

### 日志目录里有两个坑

`usage.js` 的文件头记了详细原因，这里只说结论：

- **会话目录有两种命名**：`<uuid>` 和 `session-<uuid>`。只认裸 uuid 会静默丢掉 88 个会话。
- **一个会话目录可能同时存在多份日志修订**：`session.jsonl.zstd`（最老的无版本形式）、
  `session.v3.jsonl.zstd`、`session.v4.jsonl.zstd`。harness 迁移格式时会重写日志，
  旧文件**不是**新文件的字节前缀（`seq` 被重新编号、header 多出字段），
  所以逐行去重会失效，全读会重复计费。实测本机所有旧修订都是最新修订的严格语义子集
  （按 `time` + `turn` + `step` + usage 匹配，10 个目录 0 例外），因此只读版本号最高的那份。

### 持久化索引

日志是追加写的，所以 `(size, mtimeMs)` 就能标识其内容。索引按会话存下
折叠结果 + 这对 stat 值，写盘用「临时文件 + rename」保证原子性。
刷新时只重读 size/mtime 变过的日志，稳态下每次刷新只碰一个文件（正在写的那个）。

索引位置：`~/.dsh/dshx-token-cost/index.json`，保留 400 天。

状态目录（索引 + 汇率缓存）可以用环境变量 `DSHX_TOKEN_COST_STATE` 覆盖。
测试会用它指向临时目录——否则测试里的假汇率会被写进真实缓存，
面板就会一直显示一个编造的汇率。
`INDEX_VERSION` 变更时旧索引会被丢弃并重建。

## 文件

| 文件 | 作用 |
|---|---|
| `index.js` | host 半：索引构建 + 报表整形 + 余额查询 + `GET /dshx-token-cost/report` |
| `usage.js` | 日志扫描、zstd 解码、按天×模型折叠、持久化索引 |
| `rate.js` | 汇率：来源表、响应解析与可信度校验、磁盘缓存 |
| `pricing.js` | 价目表（纯数据 + 匹配/计价函数） |
| `client.js` | 浏览器半：设置页 UI |
| `test.mjs` | 离线报告器：打印逐日逐模型费用表，供人工核对 |
| `test-endpoint.mjs` | 端点测试：桩化 ctx 调真实 handler，40+ 条断言 |
| `test-client.mjs` | 客户端测试：jsdom 真实挂载设置页，断言渲染结果 |
| `test-layout.mjs` | 排版测试：真实 Chrome 以多种宽度挂载，量溢出与截断 |

改价目表只需要动 `pricing.js`。规则按顺序匹配，**具体的写在前面**；`match` 是正则，
`provider: '*'` 表示不限来源（因为同一模型可能从多个网关进来）。

## 排版

表格用 `table-layout: fixed` + **百分比列宽**，两者缺一不可：

- 不加 `fixed`，浏览器按内容算列宽，`width: 100%` 只是建议值。八个 `nowrap` 的数字列
  会把表格顶得比卡片还宽，最后一列掉出右边界。
- 列宽用 px 而非百分比也不行。`fixed` 布局下 px 宽度会变成表格缩不下去的**下限**，
  而设置页是 flex 子项（默认 `min-width: auto`），表格缩不下去就会把整页撑宽、出现横向滚动条。
  百分比则相对表格拿到的宽度解析，表格永远放得下。

窄屏下**不减列**：面板用 `ResizeObserver` 量自身宽度，低于 `DENSE_BELOW`（640px）
就压缩**数字的位数**而不是砍列——token 取 3 位有效数字（`240.22M` → `240M`），
金额在窄屏下从三位数起就不带小数，表头也缩短（`估算费用` → `费用`），
字号降到 11.5px、内边距收紧。精确值始终在 tooltip 里。

早期版本是直接丢掉缓存读/缓存写两列的，那是错的：缓存读是 token 量的**大头**，
砍掉它等于把「这次花了多少、其中多少是缓存」这个最关键的答案藏起来。
现在最窄到约 400px 的面板也能完整显示 8 列。

日期显示为 `MM-DD`（跨年时自动带回年份），完整日期在 tooltip 里。

## 自测

```bash
node test.mjs 30            # 近 30 天逐日逐模型费用表
node test-endpoint.mjs      # 端点断言，全 PASS 才退出码 0
node test-client.mjs        # 客户端渲染断言，需要 react + jsdom
node test-layout.mjs        # 排版断言，需要 Chrome/Edge；加 --shot 出截图
```

`test-client.mjs` 依赖 `react` / `react-dom` / `jsdom`，`test-layout.mjs` 需要本机
Chrome 或 Edge。依赖可以装在任意目录（`npm install --no-save react@18 react-dom@18 jsdom`），
运行时把 `NODE_PATH`（或 `DSHX_TEST_NODE_MODULES`）指向那个 `node_modules`；脚本会在缺依赖时给出提示。

`test-layout.mjs` 把面板挂进一个带侧边栏的 flex 容器——**这一点很关键**：
普通 block 容器只会让子元素溢出，而 flex 子项的 `min-width: auto` 会让宽表格把
整个页面顶宽，也就是用户实际遇到的那个横向滚动条。用 `CLIENT_PATH=<file>` 可以
对另一份 client 构建跑同一套检查（当初就是用它验证这套断言确实能抓出旧布局的）。

## 安装位置

安装副本在 `~/.dsh/profiles/<profile>/node_modules/dshx-token-cost/`。
用本地 `file:` 依赖开发时，pnpm 装的是**拷贝**而不是软链，改完源码要重新安装或拷贝才会生效。

注册位置：

- `~/.dsh/profiles/desktop/package.json` → `dependencies`（`file:` 路径）与 `dsh.profile.bundles`（加载列表）
- `~/.dsh/profiles/desktop/cordis.patch.yml` → `- id: dshx-token-cost`

改完需重启 DSH 桌面端（host 半是新路由，且插件在启动时组进页面 bundle）。

## 端点

```
GET /dshx-token-cost/report?days=30[&force=1]
GET /dshx-token-cost/report?from=2026-10-01&to=2026-10-11[&force=1]
```

`from`/`to` 优先于 `days`，两端都含。起止写反了会被自动交换而不是报错；
跨度超过 `meta.maxDays`（365）只取最近的这些天，并在 `usage.truncated` 里标出来。
非法日期（如 `2026-02-30`）会被识别为无效，回落到 `days`。

上限同时受 `INDEX_KEEP_DAYS`（索引保留 400 天）约束——`MAX_DAYS = min(365, INDEX_KEEP_DAYS)`，
所以窗口不可能宽到索引填不满。

返回 `{ at, balance, usage }`：

- `balance` —— `{ available, isAvailable, currencies: [{currency, total, granted, toppedUp}] }`，
  失败时是 `{ available: false, reason }`；
- `usage` —— `{ available, mode, windowDays, fromDay, toDay, truncated, since, dayCount, days, models, total, meta }`。
  注意 `windowDays` 是窗口大小（数字），`days` 是逐日行数组；这两个名字在早期版本里撞过车。

`force=1` 会忽略 10 秒的索引 TTL 和 2 分钟的余额缓存，强制重新 stat 与请求。

## 安装

```sh
# Web profile
dsh plugin --profile web add github:callaumyan-design/dshx-token-cost
# Desktop（用 DSH Desktop 自带的 dsh 命令，先从托盘完全退出 Desktop）
dsh plugin --profile desktop add github:callaumyan-design/dshx-token-cost
```

安装后重启 DSH。卸载：`dsh plugin --profile <profile> remove dshx-token-cost`。

## License

MIT
