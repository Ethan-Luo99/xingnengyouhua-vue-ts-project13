# 1200 粒子 Worker + Canvas 动画：现状分析与优化技术方案

> 范围：只做代码理解与技术方案，**不改动任何源码**、不新增依赖（`package.json` 保持不变）。
>
> 阅读基线（均已真实阅读）：
> - `src/App.tsx`（题面写的 `main/src/App.tsx` 在本仓库实际为 `src/App.tsx`，无 `main/` 层）
> - `src/workers/sim.worker.ts`
> - `src/main.tsx`
> - `package.json`
> - `vite.config.ts`
> - 旁证：`src/App.css`、`src/index.css`、`index.html`
>
> 标注约定：凡涉及浏览器版本、设备相关毫秒/字节微基准的数字，均标注「推测」，并给出验证方法。

---

## 第一部分 现状逻辑还原

### 1.1 数据从 Worker 到 Canvas 的完整链路

| 环节 | 线程 | 驱动者 | 频率/量级 | 代码位置 |
| --- | --- | --- | --- | --- |
| 创建 Worker | 主线程 | 挂载 `useEffect([])` | 1 次（StrictMode 下 2 次） | `src/App.tsx:22-26` |
| 发送 tick | 主线程 | **驱动源 A：`setInterval(cb, 16)`** | ≈62.5 次/秒；消息体 `{tick, count}` 几十字节，结构化克隆；`count` 在 Worker 端被忽略 | `src/App.tsx:30-32` |
| 物理仿真 `physics` | Worker | Worker `onmessage`（消息驱动） | 每条消息：1200 粒子 × 40 = **48000 次 `Math.random()`** + 1200 次 `sin/cos`；状态写模块级 `buf` | `src/workers/sim.worker.ts:3-16,18,20-22` |
| 回传数据 | Worker→主线程 | `self.postMessage` | 先 `new Float32Array(buf)` 复制 19.2KB，再**无 transfer** 结构化克隆（主线程再得一份 19.2KB）；≈2×19.2KB/条，约 2.3MB/s 瞬态 | `src/workers/sim.worker.ts:23-24` |
| 写入 React | 主线程 | `worker.onmessage` → `setParticles` | ≈62.5 次/秒触发重渲染 | `src/App.tsx:27-29`、`src/App.tsx:17` |
| render 期分配 | 主线程 | React render | 每次渲染 `buildFilters()` 新建 **500 个闭包**；`useState(new Float32Array(...))` 初值表达式每次渲染都求值（19.2KB 白分配） | `src/App.tsx:20`、`src/App.tsx:7-14`、`src/App.tsx:17` |
| 绘制循环 | 主线程 | **驱动源 B：rAF**（`requestAnimationFrame(loop)` 自我续命） | 每条链每帧：1200 次「径向渐变 + shadowBlur=18 + arc/fill + save/restore」；**1200×500=60 万次 filter 调用 / 60 万次 `Math.sin`**（结果整体丢弃）；每帧重置位图 | `src/App.tsx:36-71`，重点 `44-45,52-64` |
| FPS 上报 | 主线程 | 每条 rAF 链每帧 `setFps` | 每帧每链 1 次 React 提交（**驱动源 C**） | `src/App.tsx:67` |
| 窗口尺寸 | 主线程 | **驱动源 D：`resize` 事件** | 事件驱动；无 `removeEventListener`；其写入的位图尺寸下一帧即被 rAF 覆盖 | `src/App.tsx:73-81` |
| 上屏 | 合成器/GPU | 浏览器 | Canvas 位图合成；HUD 文本 `particles.length` 恒为 4800 | `src/App.tsx:83-88` |

### 1.2 独立时序驱动源与相位关系

实际存在 **4 个互相独立、无锁相关系**的驱动源：

1. `setInterval(..., 16)`：不与屏幕刷新对齐。16ms 对 60Hz 的 16.67ms 每拍差 0.67ms，拍频导致「同一个 vsync 间隔内到达 0 条或 2 条 tick 消息」。
2. Worker 回传消息：延迟 = 仿真 + 克隆 + 主线程事件循环排队，抖动大；只决定 React 何时渲染，不对齐帧。
3. `requestAnimationFrame`：名义上与 vsync 对齐；但因为绘制 `useEffect` 依赖 `[filters, particles]` 且**没有 cleanup**，每次渲染都会**再新增一条永不退出的 rAF 链**（见 R2）。运行 t 秒后同时存在的 `loop` 数量 k ≈ 累积渲染次数，每帧总开销 ≈ k × 单链开销。
4. `resize` 事件：与上述三者完全异步，且与每帧位图重置相互覆盖。

**StrictMode 放大**：`src/main.tsx:7-9` 包裹 `<StrictMode/>`，开发环境挂载期 effect 执行「挂载→清理→再挂载」。

- Worker effect 的清理只 `clearInterval`（`src/App.tsx:33`），**没有 `worker.terminate()`**，于是首个 Worker 成为孤儿，仍持续向主线程 `postMessage` 并触发 `setParticles`（R4）。
- 绘制 effect 没有清理函数，StrictMode 直接留下 2 条 rAF 链起步（R2）。

> 这解释了「越跑越卡 + 内存持续增长」：不是函数多，而是 rAF 链、Worker、闭包随时间**乘法级累积且不释放**。

### 1.3 一个被性能症状掩盖的正确性事实

`particlesRef = useRef(particles)`（`src/App.tsx:19`）只在首次渲染取初值（全 0 的 `Float32Array`），**全代码库没有任何地方再写 `particlesRef.current`**；而 rAF 读的是 `particlesRef.current`（`src/App.tsx:43`）。因此即便 Worker 正常产出，绘制用的也永远是初始全零数组，粒子恒画在 `(0,0)`。「画面不动」是正确性 bug，不是性能 bug。

---

## 第二部分 风险与瓶颈清单

> 「每帧代价」中标「推测」的为设备相关量级，需用第四部分的方法实测。

| 编号 | 定位（文件+符号） | 类别 | 机制 | 每帧代价估算 | 严重度 | 修复方向 |
| --- | --- | --- | --- | --- | --- | --- |
| R1 | `src/App.tsx:19` `particlesRef` + 读取点 `src/App.tsx:43` | 正确性 | ref 只取 `useState` 初值，从不随 `setParticles` 更新；rAF 永远读全零数组，粒子恒在 `(0,0)`。**「看似性能、实为正确性」头号项** | 0（功能错误） | P0 | Worker 数据直达 ref（不进 state），rAF 读同一 ref；或用同步 effect 同步 ref |
| R2 | `src/App.tsx:36-71` 绘制 `useEffect`（无 cleanup），依赖 `[filters, particles]` | 性能/内存 | 每次渲染新增一条自我续命 rAF 链，旧链不 `cancelAnimationFrame`；每链执行 1200 阴影渐变 + 60 万 sin + 位图重置；活跃 rAF 回调是 GC root，链上 `filters`/闭包永不释放 | 单链推测 8–40ms；运行数秒后每帧 ≈ k×单链，可达数百 ms | P0 | 挂载期启动**唯一** rAF（依赖 `[]`），cleanup 中取消；数据走 ref |
| R3 | `src/App.tsx:20` `const filters = buildFilters()`（定义 `src/App.tsx:7`）+ StrictMode `src/main.tsx:7-9` | 性能/正确性（React 模型） | render 体内每次渲染新建 500 个闭包，引用永不稳定，直接逼出 R2；StrictMode 双执行再翻倍。属「render 期间分配 + effect 依赖不稳定」反模式 | 500 闭包/次渲染（约 28KB+，推测），渲染风暴时每秒数百次 | P0 | 纯函数表移到模块作用域或 `useMemo([])`；本例返回值被丢弃，直接删除 |
| R4 | `src/App.tsx:22-34` Worker effect 的 cleanup 仅 `clearInterval(timer)`（`src/App.tsx:33`） | 内存/生命周期 | 无 `worker.terminate()`；StrictMode 首个 Worker 变孤儿，其 `onmessage` 仍持续 `setParticles`；HMR 每次保存再累积一个 Worker（各自持有 19.2KB `buf` 与消息队列） | 每条孤儿 Worker ≈0.2–0.5ms CPU/秒 + 19.2KB/条（推测） | P0 | cleanup 中 `worker.terminate()`；协议加初始化/序号校验 |
| R5 | `src/App.tsx:67` rAF 内每帧 `setFps(...)` | 性能（React 模型） | rAF 回调是独立 task，不与 onmessage 批处理；每链每帧 1 次提交，渲染再建 filters、再触发 R2，是链增长的「燃料」 | k 次提交/帧，每次推测 0.2–1ms | P0 | FPS 用 ref 做滑动均值，2–4Hz 写 `textContent` 或低频 state |
| R6 | `src/App.tsx:44-45` 每帧 `canvas.width/height = clientWidth/clientHeight` | 性能/内存 | 按规范即便赋同值也重置位图：上下文状态清空、后台存储/GPU 纹理重新分配；每帧每链 k 次 | 每次推测 0.3–2ms（随分辨率上升） | P1 | 仅尺寸真变才重置；`ResizeObserver`；按 DPR 建位图 |
| R7 | `src/App.tsx:52-61` `createRadialGradient` + `shadowBlur=18` + `arc/fill`（×1200） | 性能 | `shadowBlur` 是 Canvas2D 最重光栅操作之一（模糊+离屏纹理）；每粒子还新建渐变对象、2 色标、`save/restore` | 桌面推测 15–80ms/帧；中低端移动 GPU 推测 100ms+ | P1 | 渐变+阴影烘焙成单张 sprite，1200 次 `drawImage`；或 `globalCompositeOperation='lighter'` 伪辉光 |
| R8 | `src/App.tsx:63-64` `step` 与 `filters[f](x, i)` | 性能 | 60 万次/帧、跨 500 个不同函数对象的多态调用（无法内联）+60 万 `Math.sin`；每粒子新建一个 `step` 闭包；**返回值整体丢弃，纯死代码** | 桌面推测 3–10ms；中低端推测 10–30ms | P1 | 删除；确有用途则收敛为 1 个函数 + 预计算表，移出粒子循环 |
| R9 | `src/workers/sim.worker.ts:23-24` `new Float32Array(buf)` + 无 transfer `postMessage` | 内存 | 每条消息 2 次 19.2KB 拷贝/分配；主线程卡顿时克隆数组在事件队列积压、不可 GC，表现为内存只涨不落 | 稳态 ≈2.3MB/s 瞬态；积压时约 1.2MB/分钟（推测） | P1 | transfer list + 双缓冲所有权乒乓；或 SharedArrayBuffer |
| R10 | `src/App.tsx:30-32` `setInterval(...,16)` 驱动 tick | 正确性/性能 | 无背压（上一帧未消费仍继续发）；16ms 与 16.67ms 无锁相；后台标签页 interval 被节流到 ≥1s，回前台时积压消息批量灌入 | 控制消息可忽略；代价是积压与「仿真速度≠帧率」 | P1 | 节拍权收归 rAF；in-flight≤1 + 序号丢旧；或固定步长累加器 |
| R11 | `src/App.tsx:17` `useState(new Float32Array(COUNT*4))` | 内存（React 模型） | 初值表达式每次渲染都求值（仅首次采用）；渲染风暴下白分配 19.2KB/次 | 每次渲染 19.2KB 即刻垃圾，抬升 minor GC 频率 | P2 | 惰性初始化 `useState(() => new Float32Array(...))`；更优是整体移出 state |
| R12 | `src/App.tsx:73-81` resize `useEffect` | 正确性/兼容性 | 无 `removeEventListener`；写 `window.innerWidth/Height` 与 rAF 每帧重置打架；完全不处理 `devicePixelRatio`（Retina/高 DPR 安卓发虚）；缺 `setTransform`，DPR 位图会导致坐标缩放错误 | 0/帧（事件驱动）；画质恒定损失 | P2 | `ResizeObserver`+DPR，尺寸真变才重建，cleanup 断开观察 |
| R13 | `src/App.tsx:23-26` `new Worker(url, { type: 'module' })` | 兼容性 | 依赖 **module worker**；Chrome/Edge 80+、Safari 15+、Firefox 114 才支持（版本号「推测」，需 MDN/caniuse 复核）；iOS Safari<15 构造即抛 | 0 | P2 | 明确浏览器下限；必要时准备 classic worker 入口 + 能力探测 |
| R14 | `src/App.tsx:47,67` FPS 统计口径 | 正确性（度量） | `start` 取在 `clearRect` 之后，漏掉位图重置；`1000/单帧耗时` 是瞬时倒数非均值；多链各报各的，HUD 无意义 | 0，但会误导优化决策 | P2 | 用相邻 rAF 时间戳做 EMA/滑窗，覆盖整帧，2Hz 输出 |
| R15 | `src/workers/sim.worker.ts:10-12` 内层 `k<40` 随机扰动；`sim.worker.ts:18` 硬编码 1200 | 性能/正确性 | 每 tick 4.8 万次 `Math.random`，量级 `1e-7*k` 对速度几乎无贡献（疑似占位）；主线程 `count` 被忽略（`src/App.tsx:31`），两处粒子数会漂移 | 每 tick 推测 0.1–0.5ms | P2 | 删内层循环或改解析噪声；粒子数常量单一来源 |
| R16 | 全局生命周期：无 `visibilitychange`/`IntersectionObserver` | 性能/内存 | 隐藏时 rAF 自动停但 interval 被节流仍驱动 Worker，回前台批量补发；画布滚出视口不停（本例 100vh 暂不触发）；HMR 下 R2/R4/R12 同时泄漏 | 隐藏后仍有每秒若干次 Worker 唤醒 | P2 | 可见性/相交观察暂停心跳与 rAF，恢复时钳制 `dt` |

附注：`src/App.tsx:54` 的 `OPACITY.toFixed(2)` 每粒子每帧生成一个字符串（1200 个/帧/链），并入 R7 一并消除，不单独编号。

---

## 第三部分 概念澄清与设计方案

### 3.1 「几百个函数执行」在什么条件下才是真实瓶颈

四类成本必须分开，证据形态互不相同：

| 成本类型 | 成为瓶颈的条件 | 本例情况 |
| --- | --- | --- |
| 调用开销 | 每帧 10^5~10^6 次、函数体极薄且无法内联（多态/闭包） | 60 万次/帧且调用点在 500 个**不同函数对象**间轮转（megamorphic），JIT 无法内联，确有成本：桌面推测 3–10ms、中低端 10–30ms，但**非首位** |
| 闭包/对象分配 | 每次循环/渲染都 new 函数或对象 | `step`（`App.tsx:63`）每帧 1200 个短命闭包；`filters` 每渲染 500 个且被失控 rAF 链长期持有（留存，见 R2/R3） |
| GC 压力 | 短命对象速率超过新生区回收节奏，或对象不可回收 | 渐变 1200、字符串 1200、`step` 1200、克隆数组 62.5 个/秒，本是短命垃圾；真正打穿内存的是两类**留存**：rAF 链持有的闭包、主线程事件队列里积压的克隆数组 |
| 绘制指令开销 | 高成本光栅效果 × 大量图元 | **主导项**：`shadowBlur=18` ×1200（`App.tsx:56`）+ 1200 个径向渐变，模糊在 CPU/GPU 侧离屏渲染，中低端单帧可超 100ms（推测） |

**本例主导因素排序**（推测，需实测确认）：

1. rAF 链随时间乘法累积（R2）——它把下面所有成本乘以 k，是「越跑越卡」的根因；
2. 阴影+渐变光栅化（R7）——单链下的第一大口；
3. 位图每帧重置（R6）与 React 每帧/每条消息提交（R5）；
4. 60 万次 filter 调用（R8）——真实存在但排第四，且它是**结果被丢弃的死代码**。

因此「函数太多」不是主因；主因是**时序/生命周期失控导致的重复执行**与**高成本绘制原语**。

互相独立的测量手段（任一手段只能证明自己那一层，须交叉验证）：

- **删除法（功能隔离）**：分别注释 `App.tsx:63-64`、`App.tsx:55-57`（shadow）、`App.tsx:44-45`，各跑一次长稳压测，对比帧时中位数与 P95。
- **DevTools Performance 火焰图**：看 `Function Call`/自时间与 Canvas 光栅化任务（Paint/Composite、GPU 轨道）的归属；60 万 filter 体现为 JS self time，阴影体现为 Paint/Raster 任务。
- **Performance 里 `Count / Size` 分配采样**或 `performance.memory`（仅 Chromium，非标准「推测」）：看短命对象速率 vs 留存堆大小。
- **内存时间线 + Allocation instrumentation**：堆快照对比能否 GC 回收；`Float32Array` 与闭包（`(p, idx) => ...`）的 retained size 与持有者链直接指向 R9/R2。
- **rAF 自计埋点**：在循环入口打序号计数器，一帧内若计数 >1 即直接证实 R2（无需任何外部工具）。

### 3.2 目标架构：职责边界、数据所有权、时序控制权

```
┌──────────────────────────── 主线程 ────────────────────────────┐
│ React 树（<App/>）                                             │
│  - 只持有：句柄 ref（canvas/worker）、低频 UI 状态（fps、暂停） │
│  - 不持有：逐帧粒子数据、逐帧 setState                          │
│                                                                │
│ RenderLoop（rAF，唯一一条，挂载期创建）                         │
│  - 时序主控：决定「何时消费最新仿真快照」与「何时绘制」         │
│  - 读 latestSnapshotRef（只取最新，旧帧丢弃）                   │
│  - 预烘焙 sprite：createImageBitmap / 离屏 canvas 一次          │
│  - 1200 次 drawImage(sprite)；无 shadowBlur、无逐帧渐变         │
│                                                                │
│ 桥接层（消息协议：init / state{seq} / ack / control）          │
└───────────────▲───────────────────────────┬────────────────────┘
                │ postMessage(transfer 或 SAB)│ 仅控制消息（rAF 节拍）
┌───────────────┴───────────────────────────▼────────────────────┐
│ Worker（sim.worker）                                           │
│  - 唯一拥有「仿真权威状态」buf                                  │
│  - 固定步长 dt 推进 physics；与渲染帧率解耦                     │
│  - 产出不可变快照（transfer 所有权乒乓 / 写 SAB ring buffer）   │
└────────────────────────────────────────────────────────────────┘
```

分层清单：

- **Worker 职责**：物理推进、噪声、边界；是状态唯一写者；不感知 DOM/帧率。
- **主线程 RenderLoop 职责**：节拍、消费快照、绘制、FPS/质量自适应；是唯一 rAF 注册者。
- **React 职责**：挂载/卸载编排、UI 控件与低频数值；不参与逐帧数据流。
- **数据所有权**：transfer 方案下同一时刻缓冲只有一个拥有者，乒乓交换；SAB 方案下 Worker 写、主线程读，配 `Atomics` 序号（`seq`）标识帧边界，主线程只读 `seq` 最新的完整一帧。
- **时序控制权**：**归主线程 rAF 单点所有**。Worker 不自行定步，采用「固定仿真步长 + 渲染时按需追帧」（accumulator）或「rAF 发一次 tick、in-flight≤1」。

### 3.3 帧同步与背压

原则：**渲染永不等待仿真，仿真永不压垮渲染**。

- 推进：主线程 rAF 计算 `dt`（钳制上限，如 33ms，防后台恢复跳变），按固定步长 `h`（如 1/120s）决定本帧应推进几步；步数上限（如每帧最多 5 步），丢弃追不上的历史（spiral-of-death 保护）。
- 最新值语义：主线程只保留**最新一份**快照引用；若上一帧还没被消费，新快照直接覆盖（transfer 方案）或被更高 `seq` 取代（SAB 方案）。队列长度恒 ≤1，消息不可能无限堆积。
- transfer 乒乓：Worker 持有缓冲 A/B；主线程用完（或收到新一帧时）把旧缓冲 transfer 归还，Worker 复用，稳态零分配。
- 暂停语义：`document.hidden`、画布不在视口、HMR/卸载时，rAF 停止即不再发 tick；Worker 收到 stop 或由 SAB 控制位进入空转。
- 不做按帧 `ack` 往返（会引入一帧网络式延迟），只做缓冲所有权流控。

### 3.4 数据传输选型

每帧数据量按 1200×4×4B = **19.2KB** 计。

| 方案 | 适用条件 | 每帧拷贝量级 | 优点/代价 |
| --- | --- | --- | --- |
| 结构化克隆（现状） | 小对象、低频 | 2×19.2KB（worker 显式复制 + 克隆），约 2.3MB/s | 简单；持续分配、易积压（R9） |
| Transferable（`postMessage(buf, [buf.buffer])`） | 大容量 typed array、可放弃所有权 | **0 次复制**，仅转移所有权 | 必须解决 Worker 后续写入：双缓冲乒乓；本方案首选 |
| SharedArrayBuffer | 超高频、想彻底零拷贝；可接受 COOP/COEP 头部与兼容限制 | 0 拷贝；需 `Atomics`/seq 做帧边界 | 见 3.4 注；本仓库当前 dev/preview 配置**无法直接工作** |
| OffscreenCanvas + `transferToImageBitmap` | 绘制本身也能放进 Worker（无主线程 DOM 依赖） | 位图与进程间零拷贝（GPU/合成器路径） | 把渲染整体搬走；但会失去主线程统一节拍的便利，且 `transferToImageBitmap` 在 Safari 历史支持差（「推测」需核实） |

**本例选择：Transferable 双缓冲乒乓**。

理由：19.2KB/帧在结构化克隆下带宽并非瓶颈，真正问题是**分配速率与积压留存**；transfer 零拷贝、零稳态分配，API 面与现有 `postMessage` 最接近，不要求跨源隔离头部，兼容性等于普通 Worker。SAB 作为后续在确认服务端可配 COOP/COEP 后的升级项；OffscreenCanvas 作为「渲染路径 B」（见第四部分矩阵）。

### 3.5 渲染策略（把 1200 次阴影渐变降到可接受成本）

路径 A：**sprite 烘焙 + drawImage**（推荐，画质损失小）

- 启动期用一个 64×64 离屏 canvas（或 `createImageBitmap`）把「径向渐变 + 等效辉光」画一次；辉光直接烘焙进 sprite 的 alpha 渐变，去掉逐粒子 `shadowBlur`。
- 每帧 1200 次 `drawImage(sprite, x-r, y-r, 2r, 2r)`；需要加法发光时一次性设 `globalCompositeOperation='lighter'`。
- 成本：1200 纹理 blit，通常在 1–4ms（推测）；画质代价：辉光形状固定，不能每粒子独立模糊半径，重叠处加法混合与原 `shadowBlur` 观感略有差异。

路径 B：**纯色圆点 + 整屏后处理/简化辉光**

- 每粒子只 `arc`+纯色 `fill`（无渐变无阴影），或用一张 `ImageData`/`putImageData` 批量打点；如需辉光，对整张画布做一次低分辨率模糊叠加（一次大操作替代 1200 次小操作）。
- 成本：可压到 1–3ms（推测）；画质代价：失去每粒子径向高光，观感更「平」。

路径 C（中期）：**OffscreenCanvas 移入 Worker**，仿真与绘制同线程零传输，主线程只合成；适合将来粒子数继续上量。画质与路径 A 相同，代价是兼容性与生命周期复杂度上升。

配套：位图只在尺寸/DPR 变化时重建；DPR 上限钳制（如 `min(devicePixelRatio, 2)`），避免 3x 安卓填充率爆炸。

### 3.6 与 React 的集成：什么进 state，什么不进

- **不进 state**：逐帧粒子数组（放 Worker + `latestSnapshotRef`）、rAF id、worker 实例（`useRef`）、每帧时间戳/FPS 累加器。
- **进 state（低频）**：暂停/运行、质量档位、2–4Hz 节流后的 FPS、粒子总数（配置量而非逐帧量）。
- `buildFilters` 这类纯静态表移到模块作用域；render 体内禁止 `new Worker`、大数组、闭包表。
- 读最新仿真值一律在 rAF/事件回调中读 ref，**不在 render 期间读可变 ref 参与渲染输出**（现状 render 输出里只用 `particles.length`，该值恒定，应改为配置常量）。
- HUD 直接命令式更新（`ref.textContent = ...`）或低频 state，杜绝每帧提交。

### 3.7 生命周期：应有行为 vs 当前实际

| 场景 | 应有行为 | 当前代码实际行为 |
| --- | --- | --- |
| 挂载 | 创建 1 个 Worker、1 条 rAF；sprite 烘焙一次；尺寸按 DPR 初始化 | StrictMode 下 2 个 Worker（首孤儿）、≥2 条 rAF 链；位图每帧重置 |
| 卸载 | `cancelAnimationFrame`、`terminate()`、断开 ResizeObserver/监听、回收位图 | 只 `clearInterval`；rAF 链、Worker、resize 监听全部留存（R2/R4/R12） |
| HMR（vite dev） | 旧 effect cleanup 完整释放后再挂新模块 | 每保存一次累积 Worker 与 rAF 链，内存阶梯式上涨 |
| 标签页后台化 | rAF 停即整体停；恢复后 `dt` 钳制，不追历史 | rAF 停但 interval 被节流仍驱动 Worker，恢复时积压消息批量灌入（R10/R16） |
| 画布滚出视口 | `IntersectionObserver` 触发暂停，可见再恢复 | 无处理（本例 100vh 暂不触发，属隐患） |
| 窗口尺寸变化 | `ResizeObserver` 去抖；尺寸真变才重建位图并 `setTransform(DPR)` | resize 写 innerWidth/Height，下一帧被每帧重置覆盖；无 DPR、无 cleanup |
| DPR 变化（跨屏拖动） | 同尺寸变化路径 | 完全无感知 |

---

## 第四部分 落地与验证

### 4.1 分阶段落地计划

每阶段独立可上线、可回滚；收益区间为「推测」，以 1200 粒子、中低端 Android（约骁龙 6 系级别）为目标设备，需实测校准。

#### 阶段 1：最小止血（不动架构，预计省 80% 以上掉帧与全部趋势性泄漏）

- 改动点（全部在 `src/App.tsx`，Worker 不动）：
  1. 绘制 effect 依赖改 `[]`，内部用最新 ref 取数；cleanup `cancelAnimationFrame`（消灭 R2 的 k 倍累积）。
  2. `worker.onmessage` 直接写 `particlesRef.current = e.data`，**不调 `setParticles`**（同时修好 R1，渲染不再被消息驱动）。
  3. Worker effect cleanup 增加 `worker.terminate()`（R4）。
  4. 删除 render 体内 `buildFilters()` 及 `App.tsx:63-64` 的死代码循环（R3/R8）；如要保留语义，先移出热路径。
  5. FPS 改为模块级/`useRef` 累加，HUD 用 `ref.textContent` 每 250ms 写一次（去掉 `App.tsx:67` 的每帧 `setFps`，R5）。
  6. 删除每帧 `canvas.width/height` 赋值，仅在尺寸变化时重建（R6 先做最简版：缓存上一次 clientWidth/Height）。
- 预期收益：活跃 loop 从 k 条收敛为 1 条；帧时主线程 JS 从「数百 ms 且随时间恶化」降到单链基线（推测中低端 20–60ms）；HMR/长稳压测堆不再阶梯上涨（消除主要留存源，预计回收数十 MB 量级，推测）。
- 验证：rAF 入口埋序号计数器确认一帧仅 1 次；Performance 录 60s，看任务时长是否平稳；Allocation timeline 看闭包/`Float32Array` 是否可回收。
- 回滚：单文件改动，git revert 该补丁即可。

#### 阶段 2：绘制降本（预计把绘制压进预算）

- 改动点：sprite 烘焙（离屏 canvas 画一次径向渐变+辉光），主循环改 1200 次 `drawImage`，`globalCompositeOperation='lighter'`（R7）；顺带消除 `OPACITY.toFixed(2)` 字符串（`App.tsx:54`）；DPR 感知 + `ResizeObserver`（R12）。
- 预期收益：绘制从推测 15–80ms（桌面）/100ms+（低端）降到 2–6ms（推测）；高 DPR 设备填充率下降约 1.5–2.25 倍。
- 验证：Performance 中 Paint/Raster 任务时长；低端机录屏对照帧时间；与阶段 1 做 A/B 截图目检画质。
- 回滚：sprite 生成与循环替换在同一补丁，revert 恢复阴影路径。

#### 阶段 3：传输零拷贝 + 时序/背压

- 改动点：Worker 双缓冲（A/B），`postMessage(buf, [buf.buffer])`；主线程消费完归还；节拍收归 rAF，固定步长 accumulator + 步数上限，删 `setInterval`（R9/R10）；删除 Worker 内层 `k<40` 循环、常量单一来源（R15）。
- 预期收益：消除约 2.3MB/s 瞬态分配与积压留存；后台恢复不再跳变。稳态每帧传输相关分配趋近 0。
- 验证：Allocation timeline 确认无每帧 `Float32Array`；模拟主线程长任务（rAF 内插 50ms 忙等）验证队列不增长、内存平稳。
- 回滚：保留结构化克隆分支开关（常量切换），出问题切回。

#### 阶段 4：生命周期与兼容性收口

- 改动点：`visibilitychange`、`IntersectionObserver`（R16）；HMR 自检；module worker 能力探测与降级（R13）；FPS 口径改 EMA（R14）。
- 预期收益：后台 CPU/电量趋近 0；首屏在低版本浏览器有明确降级而非白屏。
- 验证：切后台 10 分钟看任务管理器/`chrome://tracing`；Safari 旧版（或模拟器）验证构造失败被捕获。
- 回滚：独立补丁逐项 revert。

#### 阶段 5（可选）：SharedArrayBuffer 或 OffscreenCanvas

- 仅在实测证明传输仍为热点、且服务端可发 COOP/COEP 时启用 SAB；或在粒子数继续上量时把绘制迁入 OffscreenCanvas（路径 C）。收益与验证见 4.4。

### 4.2 16.7ms 帧预算表（60fps，中低端设备目标）

| 阶段 | 预算 | 说明 |
| --- | --- | --- |
| 仿真（Worker，可与主线程并行） | 3–4ms | 1200 粒子固定步长；不含传输则不占主线程帧预算，但 in-flight 延迟计入端到端 |
| 数据传输（transfer 后） | <0.3ms | 主要是 postMessage 派发与 typed array 包装；克隆方案另加 0.5–1ms+（推测） |
| 绘制（rAF 内 JS + 光栅指令提交） | 4–6ms | 1200 drawImage(sprite)；位图不重建 |
| 光栅/合成（浏览器线程，非主线程） | 3–5ms（推测） | 与主线程并行，但占 GPU；高 DPR 是主要放大项 |
| React 提交 | <0.5ms | 稳态零提交；仅 2–4Hz HUD |
| 样式/布局 | 0ms（稳态） | Canvas 与 fixed HUD 不触发布局；杜绝每帧改 DOM 尺寸 |
| 合成 | ≤1ms（推测） | 单层 canvas + 一个 fixed 元素 |
| 余量 | 2–4ms | 吸收系统抖动 |

超预算排查顺序（从最便宜、证据最直接的开始）：

1. rAF 序号计数——先排除「一帧多条 loop」（R2，最常见也最隐蔽）。
2. Performance 主线程任务按 self time 排序——区分 JS 计算（R8/filter）vs Paint/Raster（R7/shadow）vs 位图重建（R6，长任务伴随 Canvas 尺寸修改）。
3. 看每帧是否存在 React commit（User Timing / React 标记）——定位 R5/消息驱动渲染。
4. 消息队列与 Worker 轨道——判断是否积压、传输是否主导。
5. GPU/光栅轨道与 DPR——填充率问题换 sprite、钳 DPR。
6. 内存时间线并行看一眼：若帧时问题与堆增长同时出现，先按泄漏（R2/R4/R9）处理，性能数字才稳定可信。

### 4.3 度量方案

**埋点（建议用 `performance.mark/measure`，可在 Performance 面板直接分组）：**

- `frame:begin`（rAF 入口）、`frame:data`（取快照）、`frame:draw`（1200 绘制循环）、`frame:end`；
- `worker:tick`（主线程发出）/`worker:posted`（Worker 收到）/`worker:sent`/`main:recv`——四段时间差分别对应排队、仿真、克隆、主线程事件循环等待；
- 消息序号 `seq`：主线程比较「已发最大 seq − 已收最大 seq」即为积压深度（应恒 ≤1）；
- 每帧 rAF 回调自计数：`rafCount++`，在帧尾重置，>1 直接报警 R2；
- 内存：Chromium 可用 `performance.memory.usedJSHeapSize`（非标准，「推测」可用）每秒打点；正式结论以 DevTools 内存面板为准。

**DevTools Performance 区分 self time 与 total time：**

- Bottom-Up 视图按 **Self Time** 排序：定位函数自身耗时（60 万 filter 会在这里以大量匿名 `(p, idx) =>` 与 `step` 出现；阴影不会显示为 JS self time）。
- Call Tree/Event Log 看 **Total Time**：定位调用链责任（`loop` 的 total 大但 self 小，说明成本在被调函数或浏览器任务）。
- 主线程轨道上灰/紫色任务：`Paint`/`Raster Scheduled`、GPU 轨道才承载 `shadowBlur` 成本；若 JS 不热而帧仍掉，去这里找证据。
- 开启「CPU: 4×/6× slowdown」模拟中低端；Network 不相关，重点用 CPU 节流 + 低端真机。

**内存时间线佐证：**

- Performance 勾选 Memory，看 JS heap 曲线：锯齿（周期回收）正常；**锯齿底部持续抬高 = 留存泄漏**。
- Memory → Allocation instrumentation on timeline：录制 60s，按对象类型看 `Float32Array`、`(array)`/闭包；存活到录制结束的分配点直接指向 `sim.worker.ts:23` 与 `App.tsx:7/63`。
- Heap snapshot 对比（开始 → 强制 GC → 运行 60s → 强制 GC）：retained size 不回落即泄漏；在 Retainers 里应能看到 rAF 回调 → `filters` 的持有链（R2）。

**可复现基准：**

- 固定脚本：录制「加载后静置 5s + 匀速运行 60s + 切后台 10s + 回前台 30s」同一序列；
- 固定环境：同一台真机/同一 CPU 节流档位、同一视口与 DPR、浏览器版本锁定、关闭扩展；
- 指标：帧时 P50/P95/P99、掉帧数（Long Animation Frames API，`PerformanceObserver({type:'long-animation-frame'})`，兼容性「推测」需查）、60s 后堆增量、消息积压深度；
- 对照组：阶段 0（现状）/阶段 1/阶段 2 各跑 3 次取中位数；每组之间刷新页面并手动 GC，避免跨组污染。

### 4.4 兼容与降级矩阵

> 版本号均为「推测」，上线前以 MDN Browser Compatibility / caniuse 当日数据复核。

| 能力 | Chrome/Edge | Safari(macOS) | Safari(iOS) | Firefox | 备注 |
| --- | --- | --- | --- | --- | --- |
| Web Worker（classic） | 全量 | 全量 | 全量 | 全量 | 最稳基线 |
| **module worker**（`new Worker(url,{type:'module'})`，现状使用） | 80+ | 15+ | 15+（iOS 15+） | 114+ | 低版本构造抛错，需 try/catch + classic 降级（R13） |
| Transferable（ArrayBuffer 转移） | 全量 | 全量 | 全量 | 全量 | 阶段 3 首选 |
| SharedArrayBuffer | 需跨源隔离；Chromium/FF 现版本要求 COOP: same-origin + COEP: require-corp（或 credentialless） | 同需隔离；历史限制多 | iOS 上随系统版本差异大（推测） | 同需隔离 | 见下方配置结论 |
| OffscreenCanvas（canvas transfer） | 69+ | 16.4+（推测） | iOS 16.4+（推测） | 105+（推测） | 老版本不支持 `transferControlToOffscreen` |
| `OffscreenCanvas.transferToImageBitmap` | 支持 | 支持晚/有差异（推测） | 差异更大（推测） | 支持（推测） | 用前必须特性探测 |
| `createImageBitmap` | 全量 | 15+ | 15+ | 全量 | sprite 烘焙可用 |
| `IntersectionObserver` / `ResizeObserver` | 全量 | 13+/13.1+ | iOS 13+/13.1+ | 69+/69+ | 生命周期与尺寸管理可用 |

**当前 `vite.config.ts` 下 SAB 能否工作：不能（开发与默认构建均不满足跨源隔离）。**

`vite.config.ts` 只有 `plugins: [react()]`，没有任何头部配置；Vite dev server 不会默认发送：

- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: require-corp`（或 `credentialless`）

没有这两个响应头，`self.crossOriginIsolated === false`，`SharedArrayBuffer` 在受控浏览器中不可用（构造抛错或 `Atomics` 受限，具体随版本「推测」）。

需要改的位置（本次不改，仅指明）：

1. **开发环境**：在 `vite.config.ts` 加一个仅 dev 生效的轻量 server 中间件（或小插件），对文档响应设置上述两个头；不增加 npm 依赖。
2. **生产/预览环境**：在实际托管层（Nginx/CDN/静态主机）配置同样两个头；`vite preview` 验证时可在 `previewServer` 钩子加同款中间件。
3. 连带影响：启用 COEP 后，所有跨源资源（图片/字体/CDN 脚本）必须带 `Cross-Origin-Resource-Policy: same-origin` 或 CORS 头，否则被拦截——本例资源全同源，风险低。
4. 运行时以 `self.crossOriginIsolated` 做能力探测，失败回退 Transferable 乒乓。

### 4.5 高危项修复示意（仅表达意图，每段 ≤10 行，非完整实现）

**R1 + R5（数据直达 ref，HUD 命令式更新）**

```ts
// worker 消息不再驱动渲染；rAF 读同一 ref
worker.onmessage = (e) => { latestRef.current = e.data }
// rAF 内：节流写 DOM，不 setState
if (now - lastHud > 250) { hudRef.current.textContent = `${fpsEma.toFixed(0)} fps` }
```

**R2（唯一 rAF 链 + cleanup）**

```ts
useEffect(() => {
  let raf = 0
  const loop = (t: number) => { draw(latestRef.current, t); raf = requestAnimationFrame(loop) }
  raf = requestAnimationFrame(loop)
  return () => cancelAnimationFrame(raf)
}, []) // 依赖空数组；filters 不再出现于此
```

**R3（filters 移出 render；本例直接删除）**

```ts
// 模块作用域，进程内一份；或直接删除 App.tsx:63-64 死循环
const FILTERS = buildFilters()
// 组件内禁止再写 const filters = buildFilters()
```

**R4（Worker 随生命周期释放）**

```ts
useEffect(() => {
  const worker = new Worker(new URL('./workers/sim.worker.ts', import.meta.url), { type: 'module' })
  const timer = setInterval(() => worker.postMessage({ tick: performance.now() }), 16)
  return () => { clearInterval(timer); worker.terminate() } // 必须 terminate
}, [])
```

**R6 + R12（尺寸/DPR 变化才重建位图）**

```ts
const ro = new ResizeObserver(() => {
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr)
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; ctx.setTransform(dpr,0,0,dpr,0,0) }
})
ro.observe(canvas)
return () => ro.disconnect()
```

**R7（sprite 烘焙 + drawImage，一次设置 lighter）**

```ts
const sprite = document.createElement('canvas'); sprite.width = sprite.height = 64
const s = sprite.getContext('2d')!, g = s.createRadialGradient(32,32,0,32,32,32)
g.addColorStop(0,'rgba(255,255,255,.6)'); g.addColorStop(1,'rgba(0,0,0,0)'); s.fillStyle=g; s.arc(32,32,32,0,Math.PI*2); s.fill()
// 帧循环内：ctx.globalCompositeOperation='lighter'; for(...) ctx.drawImage(sprite, x-6, y-6, 12, 12)
```

**R8（删除死代码；保留时收敛为单函数+预计算）**

```ts
// 删除 App.tsx:63-64。确有需求时：单一函数、表外置、不进粒子内层循环
const TABLE = Float32Array.from({ length: 1024 }, (_, i) => Math.sin(i / 1024 * Math.PI * 2))
```

**R9 + R10（transfer 乒乓 + rAF 节拍、in-flight≤1、序号丢旧）**

```ts
// Worker: postMessage(buf, [buf.buffer]) 后换用另一块缓冲
let idle = new Float32Array(COUNT * 4) // A/B 双缓冲
self.postMessage(snapshot, [snapshot.buffer])
// 主线程 rAF：if (!inFlight) { inFlight = true; worker.postMessage({ seq, dt }) }
// 回收：worker.postMessage({ recycle: old.buffer }, [old.buffer])
```

**R11（惰性初始化；理想做法是整体移出 state）**

```ts
const [particles, setParticles] = useState<Float32Array>(() => new Float32Array(COUNT * 4))
```

**R13（module worker 能力探测与降级）**

```ts
try {
  worker = new Worker(new URL('./workers/sim.worker.ts', import.meta.url), { type: 'module' })
} catch {
  worker = new Worker(new URL('./workers/sim.classic.js', import.meta.url)) // 预编译 classic 入口
}
```

**R16（可见性/相交暂停，恢复钳制 dt）**

```ts
const onVis = () => { paused.value = document.hidden }
document.addEventListener('visibilitychange', onVis)
// rAF: const dt = Math.min((t - last) / 1000, 1 / 30); if (!paused.value) advance(dt)
```

---

## 结尾

### 置信度低于 80% 的结论 + 30 分钟内可验证实验

| # | 低置信结论（均含「推测」成分） | 30 分钟内实验 |
| --- | --- | --- |
| C1 | 单链绘制（1200 shadowBlur+渐变）在中低端机 100ms+、桌面 15–80ms | Chrome DevTools CPU 6× 节流录 10s，看 Paint/Raster 任务；再注释 `App.tsx:55-57` 对比 |
| C2 | 60 万 filter 调用桌面 3–10ms、低端 10–30ms | Performance Bottom-Up 看匿名 filter self time；删除 `App.tsx:63-64` 前后各录一次 |
| C3 | 每帧位图重置成本 0.3–2ms 且随分辨率上升 | 在 4K/DPR3 下注释 `App.tsx:44-45` 对比帧时；Performance 中观察位图重建任务 |
| C4 | 内存趋势性上涨主要来自 rAF 链持有闭包 + 消息队列克隆数组（而非短命对象 GC） | 60s Allocation timeline + 两次强制 GC 的堆快照，看 Retainers 持有链是否指向 rAF/队列 |
| C5 | transfer 乒乓可把传输相关稳态分配降到接近 0 | 改最小 demo（或临时代码分支）postMessage 带 transfer list，Allocation timeline 看 `Float32Array` 是否消失 |
| C6 | 浏览器版本矩阵（module worker / OffscreenCanvas / SAB 各版本号） | 30 分钟内查 MDN 与 caniuse 逐条核对，并在目标真机 `typeof OffscreenCanvas`、`crossOriginIsolated` 实测 |
| C7 | 16ms interval 与 60Hz vsync 的拍频导致消息 0/2 抖动 | 在 `postMessage` 与 rAF 各自打时间戳，绘制成间隔直方图即可见双峰 |
| C8 | StrictMode 下孤儿 Worker 持续触发 `setParticles` | 临时在 `worker.onmessage` 打日志，StrictMode dev 下应看到两个来源持续输出（可用 Worker 创建序号区分） |

### 需要你澄清的问题（最多 3 个，会影响架构选型）

1. **目标浏览器下限与部署环境**：是否必须支持 iOS Safari < 15（决定能否保留 module worker）？生产静态站点能否由你控制响应头（决定 SAB 路径是否可行，见 4.4）？
2. **视觉验收标准**：粒子辉光/渐变是否允许换成烘焙 sprite 与 `'lighter'` 加法混合（路径 A）？还是必须像素级保持现状观感（会显著影响能否达到 60fps）？
3. **仿真语义与那 500 个 filters / 40 次内层随机的业务含义**：`App.tsx:63-64` 的结果当前被整体丢弃、Worker `k<40` 扰动仅 1e-7 量级——它们是待实现的占位（需保留语义位置）还是可直接删除？这决定阶段 1 是「删除」还是「先外置保留」。
