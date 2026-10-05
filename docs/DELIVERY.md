# 粒子动画性能重构 — 交付说明

本说明对应 `docs/performance-analysis.md`（评审方案，未改动），分 3 个独立可回滚 commit 落地。
全部结论均为本地 headless Chromium（`chrome-headless-shell 154`，900×600）真实运行/构建证据。

- 硬性约束：`package.json`/`package-lock.json` 全程未改（依赖仍为 react/react-dom 2 个 + 12 devDeps），
  未引入任何 npm 依赖；`docs/performance-analysis.md` 未改动。
- 验证工具（puppeteer / headless chrome / 本地 .so）安装在仓库**外**的 `/tmp/shot-tool`，未进入仓库与依赖。

## 提交序列（每个单独 build 通过、可独立 revert）

| 顺序 | commit | 阶段 |
| --- | --- | --- |
| 1 | `01493f0` perf(stage1): 止血——收敛时序驱动源并清除死代码 | 止血 |
| 2 | `a658daa` perf(stage2): sprite 烘焙绘制 + Transferable 双缓冲乒乓传输 | 绘制与传输 |
| 3 | `7c00cc7` perf(stage3): 生命周期暂停与 module/classic worker 兼容降级 | 生命周期与兼容 |

逐 commit 独立 worktree 构建结果：
`01493f0 → ✓ built in 95ms`，`a658daa → ✓ built in 103ms`，`7c00cc7 → ✓ built in 117ms`（`tsc -b && vite build` 均零错误）。

最终 `npm run build` 产物：
`sim.worker-B7FsdCIt.js 0.59kB`（module）、`sim.worker.classic-B7FsdCIt.js 0.59kB`（classic 降级）、
`index-*.js 222.59kB`、`index.css 4.10kB`，`✓ built in 125ms`。

---

## 验收项逐条证据

### 1. 数据链路：Transferable 乒乓 + 拉模式背压，稳态零新增分配
- 协议：`src/workers/protocol.ts:5`（`SimTickRequest`，recycle 为随 buffer transfer 的视图）。
- Worker 单壳乒乓：`src/workers/sim.worker.shared.ts:36`（权威缓冲常驻，永不离线程）、
  `:55`（回收壳取回）、`:61-65`（原地推进 + `shell.set` 零分配快照 + 转移）。
- 主线程拉模式：`src/App.tsx:74`（`requestTick`，`inFlight` 门控，在途恒 ≤1）、`:75/:78`。
- 运行时证据（headless，真实探针）：
  - 背压：`maxInflight:1`；注入 500ms 主线程忙等后 ticks `242 / 4.5s`（≈54/s）而非恒定 60/s，
    证明主线程卡顿时仿真自动降速、无消息堆积。
  - 稳态零分配：分别在主线程与 worker 内 hook `Float32Array`/`ArrayBuffer` 构造器，
    稳态 2s 统计 `{"mainF32":0,"mainAB":0,"workerF32":0,"workerAB":0}`。
  - 无 `Cannot set on detached buffer` 类错误（`no page errors`），规避全零帧陷阱。

### 2. 时序唯一性：1 条 rAF、1 个 Worker；StrictMode/重挂/HMR 不泄漏
- 唯一 rAF 在挂载 effect 内创建，依赖 `[]`：`src/App.tsx:196`（`requestAnimationFrame(loop)`），帧尾自我续命 `:194`。
- cleanup 完整覆盖：`src/App.tsx:216` `cancelAnimationFrame`、`:222` `worker.terminate()`、
  `:219` `removeEventListener('visibilitychange')`、`:217/:218` 两个 observer `disconnect()`。
- dev(StrictMode) 运行时证据：
  - 每个 vsync 内应用 rAF 回调次数采样 45 帧，恒为 `1`（`max=1, all<=1`）。
  - Worker：`constructed:2, terminated:1, live:1`；CDP 实际 worker target 数 = 1。
  - HMR：`[vite] hot updated: /src/App.tsx` 后不新增 worker、无 page error，HUD 仍 60fps。

### 3. 死代码清除；tick 帧序号化
- `buildFilters`、render 内 filters 表、`step` 与 `filters[f](x,i)` 循环已删除（基线在 `src/App.tsx:7-14,63-64`，当前 `rg buildFilters|filters` 无命中）。
- worker `k<40` 随机内层循环与 `Math.random` 已删除（`rg 'k<40|Math.random' src/` 无命中）。
- `Date.now()` 全仓库无命中；tick 为单调帧序号：`src/App.tsx:79`（`seq += 1`），
  worker 以 `seq` 作为固定步长推进：`src/workers/sim.worker.shared.ts:61`。

### 4. 绘制：sprite 一次烘焙 + drawImage×1200，辉光保留
- 烘焙（只在挂载时执行一次）：`src/App.tsx:25 bakeSprite`，内含原径向渐变 `:33` 与 `shadowBlur :43`，
  辉光烘入 sprite alpha。
- 帧循环仅 `drawImage`：`src/App.tsx:168`（×1200）；帧循环内无 `createRadialGradient/shadowBlur/save/restore`
  （`rg` 仅命中一次性烘焙函数），逐粒子 `OPACITY.toFixed` 字符串分配随之消失。
- 视觉等价截图（同 900×600 视口、DPR 2、相同时长）：
  - 全景：`docs/evidence/visual-before.png` ↔ `docs/evidence/visual-after.png`
  - 左上角辉光高倍裁剪：`docs/evidence/visual-before-zoom.png` ↔ `docs/evidence/visual-after-zoom.png`
  - 两版均为左上角白色核心 + 紫色辉光团（粒子因原物理本身聚集在原点，前后观感一致）。

### 5. 画布尺寸：ResizeObserver 单一写入源 + DPR 钳制 + setTransform
- `src/App.tsx:121` 唯一 `ResizeObserver(applyCanvasSize)`；位图写入只在 `:115-117`（RO 回调内）。
- DPR：`:102` `Math.min(window.devicePixelRatio || 1, 2)`；`:117` `setTransform(dpr,...)`。
- 挂载期同步初始化 `:120`，消除「RO 首次回调晚于首帧」竞态；帧循环内只读 `cssWidth/cssHeight`，
  无任何 `canvas.width/height` 赋值（`rg` 仅命中 RO 回调）。

### 6. React 边界：buffer 不进 state；FPS 真实帧间隔滑窗、≤4Hz
- 粒子数据只活在 effect 局部 `display`（`src/App.tsx:68`），不进 `useState`；组件内无逐帧 setState。
- FPS：真实相邻 rAF 时间戳滑窗 `src/App.tsx:141`（60 帧环形缓冲，`:153-160` 采样，丢弃异常大间隔），
  以 250ms（4Hz）直写 `textContent`：`:182-189`。HUD 实测 `fps 60 / 16.7ms`，
  是真实帧间隔均值而非绘制段耗时倒数。

### 7. 生命周期：隐藏 / 滚出暂停，恢复 dt 钳制
- `visibilitychange`：`src/App.tsx:130-138`；`IntersectionObserver`：`:124-128`。
- 暂停门控：`src/App.tsx:75`（`requestTick` 内 `paused` 判断），暂停时不发请求、无积压。
- 恢复 dt 钳制：`:15` 阈值 `MAX_FRAME_DELTA_MS=100`，`:153-160` 超阈帧间隔不采样且重置滑窗，
  `:137` 恢复时重置 `lastFrameTime`；不做追帧累积。
- 运行时证据：隐藏 1.5s `ticksDuringHidden:0`，恢复首秒 `61`（无突发追帧）；
  画布离屏 1.5s 仅 1 个在途残帧，回视口首秒 `59`。

### 8. 兼容：module worker 能力探测 + classic 降级（Vite 体系内、零依赖）
- 工厂：`src/workers/createSimWorker.ts`；同步构造抛错 `:29-35`、
  error 事件 `:44`、ready 握手 1s 超时 `:40` 三种失败均回退 classic `:23`。
- 双入口共用 `src/workers/sim.worker.shared.ts`；module `sim.worker.ts:4`、
  classic `sim.worker.classic.ts:5`，均为相对路径**字符串字面量**，
  Vite 分别打包为带哈希的独立 worker 资源（避免「直引 .ts 生产 404」陷阱，见最终产物两个 worker 文件）。
- ready 握手：`src/workers/sim.worker.shared.ts:48`。
- 运行时证据：模拟 module 构造同步抛错 → module 尝试 1 次、classic 1 次，classic 路径稳定 60fps、无 page error。

---

## 遗留风险
1. 辉光为烘焙 sprite：发光半径/形状固定，重叠处叠加与逐粒子 `shadowBlur` 在像素级存在细微差异
   （方案 3.5 路径 A 已声明的取舍）；当前物理使粒子聚集原点，视觉影响不可见。若未来粒子散开，
   可将 `globalCompositeOperation='lighter'` 显式开启（当前重叠极少，未强行改混合模式以免改变观感）。
2. 每帧 worker 仍有一次 19200 字节的权威→壳 `set` 拷贝（约 4800 floats，<0.1ms 量级）。
   要彻底零拷贝需 SharedArrayBuffer，而现有 Vite/托管未发 COOP/COEP 头、`crossOriginIsolated=false`，
   按方案 4.4 本次不启用。
3. 真实中低端 Android 机未在本环境实测；headless 桌面稳定 60fps 与内存平稳已验证，
   真机建议按方案 4.3 的固定脚本 + CPU 节流复测 P95 帧时。
4. IntersectionObserver 对本例 100vh 画布正常生效（已用 transform 离屏验证）；若后续布局改变，
   需确认观察目标仍为 canvas 本身。

## 回滚方式
- 整体回滚：`git revert 7c00cc7 a658daa 01493f0`（按相反顺序）即回到基线 `9210431`。
- 单阶段回滚：各 commit 独立、单独 build 通过，可只 `git revert <commit>`：
  - 仅回滚兼容/生命周期 → revert `7c00cc7`；
  - 回滚传输/绘制改造（保留止血）→ revert `a658daa`；
  - 回滚止血 → revert `01493f0`（恢复原始多驱动源基线）。
- `docs/evidence/` 仅为截图证据，删除不影响运行。
