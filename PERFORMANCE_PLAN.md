# Worker + Canvas 粒子动画：现状分析与优化方案

> 范围：代码理解与设计方案，不含代码改动。
> 实际阅读文件（任务描述中的 `main/` 前缀在本仓库不存在，实际路径在仓库根）：
> `src/App.tsx`、`src/workers/sim.worker.ts`、`src/main.tsx`、`package.json`、`vite.config.ts`。
> 目标：1200 粒子，中低端设备稳定 60fps，长时间运行内存不涨。

## 第一部分 现状逻辑还原

### 数据链路（Worker 产生 → Canvas 上屏）

1. **仿真驱动（主线程 → Worker）**：`src/App.tsx:30` 的 `setInterval(..., 16)` 每 16ms 向 Worker 发 `{ tick: Date.now(), count: COUNT }`。驱动源是 `setInterval`，**不与 vsync 对齐**，后台标签页会被节流至约 1Hz。
2. **仿真计算（Worker 线程）**：`src/workers/sim.worker.ts:20` 的 `self.onmessage` 调用 `physics(buf, tick)`：1200 粒子 x（4 次读写 + `Math.sin`/`Math.cos` + 40 次 `Math.random()` 死循环，`sim.worker.ts:11-13`）约每 tick 4.8 万次无效随机调用，单次量级 <1ms。随后 `new Float32Array(buf)`（`sim.worker.ts:23`）复制 19.2KB（1200x4x4B）并 `postMessage(copy)` —— 走**结构化克隆**，非 Transferable。
3. **消息回灌（Worker → 主线程）**：`src/App.tsx:27` 的 `worker.onmessage` 调 `setParticles(e.data)`，每条消息触发一次 React render（约 60 次/秒），render 体内 `buildFilters()`（`src/App.tsx:20`）新建 500 个闭包。
4. **绘制（主线程 rAF）**：`src/App.tsx:42` 的 `loop` 由 `requestAnimationFrame` 驱动，每帧读 `particlesRef.current`（**永远是初始零 buffer**，见第二部分 #2），执行 1200 x（`createRadialGradient` + `shadowBlur=18` + `save/restore` + `arc/fill`）+ 1200x500 = 60 万次 `filters[f](x, i)` 死计算（`src/App.tsx:63-64`），再 `setFps(...)`（`src/App.tsx:67`）又触发一次 render。

### 独立时序驱动源：3 条，互相无相位关系

- `setInterval(16ms)`（`src/App.tsx:30`）：仿真推进时钟，墙钟驱动，会漂移、后台节流；
- `requestAnimationFrame`（`src/App.tsx:68,70`）：绘制时钟，vsync 对齐，后台暂停；
- Worker `postMessage` → `setParticles`（`src/App.tsx:27-29`）：React 渲染时钟，消息到达即渲染。

三者无任何同步：120Hz 屏上 rAF 跑 120fps 而仿真只走 60 tick/s；主线程卡顿时 Worker 消息无限堆积（无背压）；`tick: Date.now()`（`src/App.tsx:31`）使仿真速度跟随墙钟而非帧号，掉帧时仿真反而"快进"。

## 第二部分 风险与瓶颈清单

| 编号 | 定位（文件+符号） | 类别 | 机制 | 每帧代价估算 | 严重度 | 修复方向 |
|---|---|---|---|---|---|---|
| 1 | `src/App.tsx:71` effect2 依赖 `[filters, particles]` 且**无 cleanup** | 性能+内存 | 每次 render 重跑 effect 都新增一条 `requestAnimationFrame(loop)` 链，旧链永不取消；第 N 帧有约 N 条循环并发，每条闭包还持有当次 render 的 500 个 `filters` 闭包 | 随运行时间**线性增长**，数秒内主线程饱和 | 致命 | effect 返回 `cancelAnimationFrame`，deps 改 `[]` |
| 2 | `src/App.tsx:19` `particlesRef = useRef(particles)` 后**从不更新** | 正确性（看似性能问题） | 用 ref 绕开 effect 重订阅是性能手法，但 `particlesRef.current` 永远指向初始零 buffer，Canvas 画的根本不是 Worker 数据；`setParticles` 更新只用于 `particles.length` 显示 | 整条数据链失效 | 致命 | onmessage 中同步 ref，或数据只走 ref |
| 3 | `src/App.tsx:67` `setFps` 每帧 setState | 性能（React 模型） | 每帧 render → `buildFilters()` 重建 → effect2 因 `filters` 引用变化重跑 → 喂养 #1 的循环爆炸 | 放大器，约 1-3ms + 间接致命 | 高 | fps 节流到 4Hz 或直接写 DOM `textContent` |
| 4 | `src/App.tsx:20` `buildFilters()` 在 render 体内调用 | 性能+内存 | 每次 render 新建 500 闭包数组；被 #1 泄漏的 rAF 闭包长期持有 → 内存单调增长主因之一 | 分配约 0.2ms + GC 压力 | 高 | 移出组件或 `useMemo`；本例应整体删除（#5） |
| 5 | `src/App.tsx:63-64` `step(filters[f](x, i))` 死代码 | 性能 | 60 万次/帧 `Math.sin` + 闭包调用，返回值被丢弃，纯浪费 | 3-10ms（推测） | 高 | 整段删除 |
| 6 | `src/App.tsx:44-45` 每帧 `canvas.width = canvas.clientWidth` | 性能 | 写 `width` 重置 backing store 与全部上下文状态，每帧重新分配全屏位图；且未乘 `devicePixelRatio` | 1-4ms（推测）+ 高分屏模糊 | 高 | 仅 resize 时设置，乘 DPR |
| 7 | `src/App.tsx:52-62` 每粒子 `createRadialGradient` + `shadowBlur=18` | 性能 | 1200 次/帧渐变对象分配 + 每形状高斯模糊光栅，shadowBlur 是 Canvas2D 著名慢路径 | 5-15ms（推测，设备相关） | 高 | 烘焙一次 sprite，每帧 `drawImage` |
| 8 | `src/App.tsx:22-34` effect1 cleanup 只 `clearInterval`，无 `worker.terminate()` | 内存 | `src/main.tsx:32` StrictMode 双执行 → dev 下常驻 2 个 Worker；HMR/重挂载每次再 +1 | 每挂载 +1 Worker | 高 | cleanup 中 `worker.terminate()` |
| 9 | `src/App.tsx:30` + `sim.worker.ts:20` 推模式无背压 | 内存+正确性 | 主线程慢时 `onmessage` 队列无界堆积（每条约 19.2KB）；后台标签页 interval 与 rAF 脱相位 | 队列无界，内存增长源之二 | 高 | rAF 拉模式：画完一帧才请求下一 tick |
| 10 | `sim.worker.ts:23-24` `new Float32Array(buf)` + 非 transfer 的 `postMessage` | 性能 | 每帧 19.2KB 结构化克隆 + 临时对象进 GC | 0.05-0.2ms + GC churn | 中 | Transferable 双缓冲 |
| 11 | `sim.worker.ts:11-13` `physics` 内层 `for k<40` + `Math.random()` | 性能+正确性 | 4.8 万次/帧无效随机；仿真不可复现、无法做基准对比 | 0.3-1ms（Worker 内，不阻塞主线程） | 中 | 删除；需要噪声则用种子化 PRNG |
| 12 | `src/main.tsx:32` `<StrictMode>` | 正确性（React 模型） | dev 下 effect 双执行，直接放大 #1/#8/#13；当前 cleanup 均不完备，dev 与生产行为不一致 | 全局翻倍 | 高 | 补齐 cleanup 后 StrictMode 自然免疫 |
| 13 | `src/App.tsx:73-81` resize effect 无 cleanup，且与 `loop` 争写 `canvas.width` | 内存+正确性 | 监听器泄漏（StrictMode 下 x2）；`window.innerWidth` 与 `clientWidth` 两个写入源互相覆盖 | 小但持续 | 中 | cleanup `removeEventListener`，改 `ResizeObserver` 单一写入 |
| 14 | `src/App.tsx:23-26` `new Worker(url, { type: 'module' })` | 兼容性 | module worker：Firefox <114、Safari <15 不支持（推测，需 caniuse 核实）；Vite 构建期可打包规避 | — | 中 | 构建期打包为 classic worker，或特性检测降级 |
| 15 | `src/App.tsx:67` fps 口径 | 正确性 | `1000 / (performance.now() - start)` 只测绘制段耗时，不是真实帧率；掉帧时反而显示"高 fps" | — | 低 | 测相邻两次 rAF 回调间隔 |

**说明**：#2 是"看似性能问题、实为正确性问题"；#3/#12 与 React 渲染模型直接相关（effect 依赖数组、StrictMode 双执行、render 期间读可变 ref）；#14 是兼容性项（API：`Worker` 构造器的 `type: 'module'`）。主因不是"函数太多"，而是 #1 的 rAF 链无限累积——函数调用只是被乘了 N 倍。

## 第三部分 概念澄清与设计方案

### 1. "几百个函数执行"何时才是真瓶颈

- **调用开销**：单调形态（monomorphic）函数调用约 1-5ns/次，要到约 10^7 次/帧才构成瓶颈。本例 60 万次/帧的纯调用开销 <3ms，且 `filters` 数组元素形态一致，不会退化到 megamorphic。
- **闭包与对象分配**：`buildFilters()` 每次 render 分配 500 闭包，真正代价在 GC 与被泄漏闭包持有（#4），不在调用。
- **GC 压力**：每帧 1200 个 `CanvasGradient`（`src/App.tsx:52`）+ 每 render 500 闭包 → minor GC 高频，表现为帧耗毛刺。
- **绘制指令开销**：`shadowBlur` 逐形状高斯模糊，单次 fill 可达数十微秒 x1200，**本例主导**（推测，置信度约 75%）。
- **互相独立的测量手段**：
  1. DevTools Performance 看 `loop` 的 self time 与 `fill` 的 self time 占比（CPU 维度）；
  2. 消融实验——分别注释 `src/App.tsx:64` 与 `shadowBlur`（`src/App.tsx:56-57`）各录 10s 对比帧耗（对照维度）；
  3. Memory 时间线看 JS heap 锯齿频率（GC 维度）。

  三者结论一致才可下判断。若函数调用不是主因，主因依次是：**#1 循环累积 > #7 光栅开销 > #6 每帧画布重置**。

### 2. 目标架构

```
+-----------------------------------------------------------+
| 主线程（UI 线程）                                          |
|   React 组件树：只持有 canvas ref、fps 显示                 |
|   rAF 循环（唯一时钟源）                                    |
|     ├─ 消费最新一帧 positions（ref，非 state）              |
|     ├─ Canvas 2D 绘制（sprite drawImage x1200）             |
|     └─ 绘制完成后 → 向 Worker 请求下一 tick                 |
+-----------------------------------------------------------+
| Worker                                                    |
|   拥有仿真状态 buf（SoA Float32Array，数据所有权）          |
|   被动响应 tick 请求：physics 步进 → transfer 回传          |
|   不持有任何定时器                                          |
+-----------------------------------------------------------+
```

数据所有权：仿真状态归 Worker；渲染资源（sprite、ctx）归主线程；React 只拥有"是否存在画布"这一事实。时序控制权归主线程 rAF（后续可迁移为 Worker 内 OffscreenCanvas 自驱）。

### 3. 帧同步与背压

**拉模式 + 单在途信用（in-flight = 1）**：主线程 rAF 回调绘制完成后才 `postMessage({type:'tick'})`；Worker 回传时附带 buffer 所有权转移；主线程收到回传前不再发新请求。

- 仿真永远不会跑在绘制前面超过 1 帧，消息队列有界（<=1）；
- 主线程卡顿自动降速仿真，而非堆积消息；
- 标签页隐藏时 rAF 自停，整条链路自然冻结，无需额外逻辑。

### 4. 数据传输选型

| 方案 | 每帧拷贝量级 | 适用条件 | 本例适配 |
|---|---|---|---|
| 结构化克隆（现状 `sim.worker.ts:24`） | 19.2KB 全量拷贝 + GC | 原型期、低频 | 可用但每帧制造垃圾 |
| **Transferable（双缓冲）** | **约 0 拷贝（所有权转移）** | 单向传递、不需要共享 | **本例选择** |
| SharedArrayBuffer | 0 拷贝 + Atomics 同步 | 双向高频共享、可接受 COOP/COEP 隔离代价 | 为 19.2KB 引入跨源隔离不划算，且当前 `vite.config.ts` 不支持（见第四部分 4） |
| OffscreenCanvas + `transferToImageBitmap` | 位图所有权转移，主线程仅 `drawImage` | 光栅化本身也要移出主线程 | 阶段 5 可选升级 |

理由：19.2KB/帧 x60fps 约 1.15MB/s，结构化克隆也能扛，但 transfer 实现成本几乎相同且彻底消除该链路的分配；SAB 省的约 0.1ms 抵不上跨源隔离对第三方资源的约束。

### 5. 渲染策略（1200 次带阴影渐变 → 可接受成本）

- **路径 A：sprite 烘焙（零画质损失，首选）**。当前所有粒子的渐变与阴影参数完全相同（`OPACITY`、`#639`、半径 6/12 都是常量），一次性画到 24x24 离屏 canvas，每帧 1200 次 `ctx.drawImage(sprite, x-12, y-12)`，预计 1-2ms。
- **路径 B：批量路径 + 纯色（有画质代价）**。单次 `beginPath()` + 1200 个 `arc` + 一次 `fill`，去掉阴影和渐变，<1ms，但失去发光感。
- 辅助：DPR 上限钳制（`min(devicePixelRatio, 2)`）、离屏区域跳过（`IntersectionObserver`）。

### 6. 与 React 的集成

- 仿真数据（positions、buffer）**永不进 state**——存 `useRef` 或模块级外部 store；
- `fps` 等低频展示用 `useSyncExternalStore` 订阅 250ms 节流的外部计数器，或绕过 React 直写 `textContent`；
- 组件树只负责：挂载/卸载画布、传达尺寸与 DPR、展示聚合指标；
- `particles`、`filters` 这类每帧/每 render 变化的值不进 `useState`，也不进 effect 依赖数组。

### 7. 生命周期：应有行为 vs 当前实际

| 场景 | 应有行为 | 当前实际（符号） |
|---|---|---|
| 挂载 | 1 个 Worker、1 条 rAF 链 | StrictMode 下 2 个 Worker（`src/App.tsx:23` 无 terminate）、rAF 链持续增长 |
| 卸载 | `terminate()` + `cancelAnimationFrame` + 移除监听 | 仅 `clearInterval`（`src/App.tsx:33`），其余全漏 |
| HMR | effect cleanup 完整回收，热替换无残留 | 每次热更新多漏 1 个 Worker + N 条 rAF 链 |
| 标签页后台化 | 整条链路冻结（rAF 自停 + 拉模式自停） | `setInterval` 被节流到 1Hz 仍推仿真，消息继续到达触发 `setParticles` 无效 render |
| 画布滚出视口 | `IntersectionObserver` 暂停绘制与仿真请求 | 无处理，离屏照画 |
| 尺寸/DPR 变化 | `ResizeObserver` 单一写入 `canvas.width = clientWidth * dpr` 并 `ctx.setTransform(dpr,...)` | 两处写入源打架（`src/App.tsx:44` vs `src/App.tsx:77`），DPR 完全未处理 |

## 第四部分 落地与验证

### 1. 分阶段落地计划

- **阶段 1（止血，不改架构）**：effect2 加 `cancelAnimationFrame` cleanup 且 deps 改 `[]`；effect1 cleanup 加 `worker.terminate()`；effect3 加 `removeEventListener`；删除每帧 `canvas.width` 赋值（`src/App.tsx:44-45`）；`onmessage` 里同步 `particlesRef.current = e.data`。
  预期收益：帧耗从线性增长 → 稳定（消除 #1 后单帧回到 10-25ms 区间，推测）；内存曲线由单调升 → 有界锯齿。
  验证：Performance 录 60s 对比帧耗斜率 + Memory 时间线。回滚：`git revert` 单 commit。
- **阶段 2（删死代码 + 绘制）**：删 `buildFilters`/`step` 调用（`src/App.tsx:20,63-64`）与 `physics` 的 k 循环（`sim.worker.ts:11-13`）；sprite 烘焙替代渐变 + shadow。
  预期收益：主线程绘制段 → <=3ms。验证：消融前后 `loop` self time。回滚：独立 commit 单独 revert。
- **阶段 3（时序与背压）**：`setInterval` 改 rAF 拉模式（in-flight=1）+ Transferable 双缓冲。
  预期收益：消息队列恒 <=1，传输分配归零，后台标签页零消耗。验证：heap 时间线 60s 平坦。回滚：revert。
- **阶段 4（React 解耦）**：`particles` 移出 state；`setFps` 节流 250ms 或直写 DOM；`ResizeObserver` + DPR。
  预期收益：React 提交 60 次/s → <=4 次/s，单次提交 <0.5ms。验证：Profiler 提交次数。回滚：revert。
- **阶段 5（可选）**：绘制迁入 Worker 的 OffscreenCanvas + `transferToImageBitmap`，主线程每帧仅一次 `drawImage`。
  预期收益：主线程绘制段 → <0.5ms，但引入 Safari <16.4 兼容性分支（推测，需 caniuse 核实）。
  验证：低端机实测 + 特性检测回退路径。回滚：保留阶段 4 的主线程绘制路径作降级分支，开关切换。

### 2. 一帧 16.7ms 性能预算表

| 分段 | 预算 | 说明 |
|---|---|---|
| 仿真（Worker，与主线程并行） | <=2ms | 不占主线程预算，但决定数据是否迟到 |
| 数据传输（transfer + 消息分发） | <=0.3ms | 19.2KB 所有权转移 |
| 绘制（1200 次 `drawImage`） | <=6ms | sprite 化后实测应 1-3ms，留余量 |
| React 提交 | <=1ms | 节流后每 4-5 帧才有一次提交 |
| 样式/布局 | <=1ms | 无布局抖动源时应接近 0 |
| 合成 | <=2ms | canvas 单图层，注意 `will-change` 勿滥用 |
| 余量 | >=4ms | 吸收 GC 毛刺与低端机波动 |

超预算排查顺序：
1. Performance 面板定位 long task 在**哪个线程**（主线程 vs Worker 各有泳道）；
2. 主线程内按 self time 排序，区分是 `loop`（JS）、`fill`/`drawImage`（光栅）还是 `Recalculate Style`；
3. 消融（关绘制/关仿真各录 10s）；
4. JS 与光栅都不高但帧间隔大 → 查合成层与 GPU（Layers 面板）；
5. Worker 数据迟到 → 看 `tick` 请求到 `onmessage` 的标记差值。

### 3. 度量方案

- **埋点**：`performance.mark`/`performance.measure` 包四段——`tick-request → onmessage`（传输+仿真延迟）、`onmessage` 处理体、`loop` 绘制段、相邻 rAF 间隔（真实帧率，替代 `src/App.tsx:67` 的错误口径）。
- **self time vs total time**：Performance 面板 Bottom-Up 视图按 self time 降序——`loop` self time 高说明 JS 指令本身多（函数调用/数学运算）；`fill`/`drawImage` self time 高说明光栅是瓶颈；`loop` total 高但 self 低说明开销在子调用。三者对应完全不同的修法。
- **内存佐证**：Memory 面板录 60s，健康状态 JS heap 呈**有界锯齿**（minor GC 后回落）；当前代码应呈单调阶梯上升（rAF 闭包 + `filters` 数组泄漏）。修复后拍两份 heap snapshot 对比 `Closure` 数量，确认不再累积。
- **可复现基准**：先删 `Math.random()`（或换种子 PRNG）使仿真确定；固定窗口尺寸与 DPR；每次跑固定 60s，记录平均帧耗、P95 帧耗、heap 净增量三个数；同机同浏览器版本前后对照。`tick` 改用帧序号而非 `Date.now()`（`src/App.tsx:31`），否则基准不可复现。

### 4. 兼容与降级矩阵

（版本号均为推测，验证方法：caniuse 搜对应 API + 目标浏览器控制台特性检测）

| API | Chrome | Safari（含 iOS） | Firefox |
|---|---|---|---|
| `OffscreenCanvas` | 69+ | 16.4+（iOS 同） | 105+ |
| `SharedArrayBuffer` | 支持，但需 `crossOriginIsolated` | 15.2+，同样需隔离 | 支持，同样需隔离 |
| Worker `{ type: 'module' }` | 95+ | 15+ | 114+ |

**当前 `vite.config.ts` 下 SharedArrayBuffer 不能工作**：配置只有 `plugins: [react()]`，没有 COOP/COEP 响应头，`crossOriginIsolated === false`，`SharedArrayBuffer` 构造器直接不可用。若要用，需在 `vite.config.ts` 加 `server.headers` 与 `preview.headers`：`Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`（第三方资源还需配套 CORP）。验证：dev server 控制台执行 `crossOriginIsolated`。按第三部分 4 的结论，本例不需要走这条路。

### 5. 高危项修复示意（各 <=10 行，仅表意图）

#1 rAF 链累积（`src/App.tsx:42-71`）：

```ts
useEffect(() => {
  let raf = 0
  const loop = () => { /* draw */ raf = requestAnimationFrame(loop) }
  raf = requestAnimationFrame(loop)
  return () => cancelAnimationFrame(raf)   // 关键：取消
}, [])                                       // 关键：空依赖
```

#2 `particlesRef` 不更新（`src/App.tsx:19,27-29`）：

```ts
worker.onmessage = (e: MessageEvent<Float32Array>) => {
  particlesRef.current = e.data            // 直接写 ref，不走 state
}
```

#3 `setFps` 每帧提交（`src/App.tsx:67`）：

```ts
if (frame % 15 === 0) fpsNode.textContent = `fps ${fps}` // 直写 DOM
```

#7 阴影渐变 → sprite（`src/App.tsx:52-62`）：

```ts
const sprite = document.createElement('canvas') // 挂载时烘焙一次
sctx.shadowBlur = 18; sctx.fillStyle = grad; sctx.fill()
// 每帧：
for (let i = 0; i < COUNT; i++)
  ctx.drawImage(sprite, data[i*4] - 12, data[i*4+1] - 12)
```

#8 Worker 泄漏（`src/App.tsx:33`）：

```ts
return () => { clearInterval(timer); worker.terminate() }
```

#9 无背压（`src/App.tsx:30-32` + `sim.worker.ts:20`）：

```ts
// 主线程：画完才请求下一帧；在途请求 <=1
const tick = () => { if (!waiting) { waiting = true; worker.postMessage('tick') } }
// Worker 回传时 transfer：
const out = new Float32Array(buf); self.postMessage(out, [out.buffer])
```

## 结尾

### 置信度 <80% 的结论与 30 分钟内可验证的实验

- `shadowBlur=18` 是绘制段最大开销（约 75%）：注释 `src/App.tsx:56-57` 两行，Performance 录 10s 对比 `fill` self time。
- 60 万次死调用的精确毫秒数（约 70%）：删除 `src/App.tsx:64` 循环，同法对比。
- 每帧写 `canvas.width` 是否触发 GPU 位图重分配（约 60%）：注释 `src/App.tsx:44-45` 对比，并观察 Memory 中 GPU/位图曲线。
- 三个浏览器版本号（module worker / OffscreenCanvas / SAB）：分析时联网检索不可用，未核实；caniuse 各查一次即可，约 10 分钟。
- React 19 对相同值 `setFps` 的 bailout 是否每帧仍调度（约 75%）：Profiler 录 5s 看提交次数是否约等于帧数。

### 需要澄清的问题（影响架构选型，最多 3 个）

1. 目标浏览器基线是什么？是否含 Safari <16.4 / iOS 旧版本——决定阶段 5 的 OffscreenCanvas 是主路径还是增强路径。
2. 粒子视觉是否确定"全部同款式"（当前 `OPACITY`、`#639`、半径均为常量）？若未来要逐粒子异色，sprite 烘焙需改为多 sprite 或 `globalCompositeOperation` 调色。
3. 仿真是否要求确定性/可回放？决定能否删 `Math.random()`、把 `tick: Date.now()` 改为固定步长帧序号。
