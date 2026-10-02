# 性能优化交付说明（3 阶段，逐条验收证据）

基线：`9210431 snapshot: deliverable snapshot 2026-10-02 23:33`
目标方案：`docs/performance-analysis.md`（仅参考，未照抄示意代码）

## Commit 与回滚

| 阶段 | Commit | 内容 | 回滚 |
| --- | --- | --- | --- |
| 1 止血 | `84bd8d4` | 唯一 rAF 链 + Worker 随卸载释放，数据绕开 React 直达 ref | `git revert 84bd8d4` |
| 2 绘制与传输 | `1cdb1a9` | sprite 烘焙 + drawImage；Transferable 双缓冲乒乓 + 拉模式背压 | `git revert 1cdb1a9` |
| 3 生命周期与兼容 | 见 `git log` 最新 | 可见性/视口暂停 + dt 钳制；module worker 探测 + classic 降级 | `git revert <stage3-sha>` |

每个 commit 前均运行 `npm run build`（`tsc -b && vite build`）零错误；最终 `npm run lint` 零告警。

## 每阶段 build 输出（关键行）

- 阶段 1：`✓ 17 modules transformed. / dist/assets/sim.worker-C_AoPU1e.js 0.38 kB / ✓ built`（零错误）
- 阶段 2：`✓ 17 modules transformed. / dist/assets/sim.worker-CgOeByUp.js 0.61 kB / ✓ built`（零错误）
- 阶段 3：`✓ 17 modules transformed. / dist/assets/sim.classic.worker-kNC9fPpW.js 0.62 kB + dist/assets/sim.worker-kNC9fPpW.js 0.62 kB / ✓ built`（零错误，双 worker 入口均产出）

## 逐条验收证据

### 1. 数据链路（Transferable 双缓冲乒乓 / 拉模式 / 稳态零分配）
- Worker 侧乒乓池与 transfer：`src/workers/sim-core.ts:33-34`（spare 池 2 块缓冲）、`src/workers/sim-core.ts:55-64`（tick→写快照→`postMessage(frame,[buffer])` 转移所有权）；权威状态 `state` 永不 transfer（`src/workers/sim-core.ts:26`）。
- 主线程消费即归还：`src/App.tsx:136-138`（recycle 旧快照 buffer 回 Worker）。
- 拉模式在途 ≤1：`src/App.tsx:170-174`（`!inFlight` 才发 tick），`src/App.tsx:135`（收到 frame 才复位）；主线程卡顿时 tick 停发，仿真自然降速、无消息队列可堆积。
- 实测：Chromium `performance.memory.usedJSHeapSize` 10s 采样 `9.5 -> 9.5 -> ... -> 9.5 MB`（持平无趋势增长）。

### 2. 时序唯一性（1 条 rAF / 1 个 Worker，三场景不泄漏）
- 唯一 rAF 注册点 `src/App.tsx:190`，唯一 Worker 创建点 `src/App.tsx:82`，均在同一 `useEffect(..., [])`。
- cleanup 全覆盖：`src/App.tsx:192-199`（cancelAnimationFrame / ro.disconnect / io.disconnect / removeEventListener / terminate）。
- 实测（CDP `Target.setDiscoverTargets` 统计 dedicated worker 数）：
  - dev + StrictMode 挂载 5s 后：worker targets = 1；
  - 连续 2 次 reload 后：均 = 1；
  - 连续 3 次 HMR（改写 `src/App.tsx` 触发 vite 热更）后：均 = 1。

### 3. 死代码清除
- `buildFilters`、`step`/`filters[f](x,i)` 循环已删（`git show 84bd8d4`）；`grep -n 'buildFilters\|filters\[' src/` 无结果。
- physics 内层 `k<40` 随机循环已删：`src/workers/sim-core.ts:30-41` 仅剩位置/速度积分。
- tick 为固定步长累加的仿真时间（`src/App.tsx:149,172`：dt 钳制 ≤100ms 后累加），全仓库 `grep -rn 'Date.now' src/` 无结果。

### 4. 绘制（sprite 烘焙 + drawImage ×1200）
- 烘焙：`src/App.tsx:15-40`（离屏 canvas 一次画 #639 辉光 + 白色径向核心）；帧循环仅 `drawImage` ×1200 + 一次 `globalCompositeOperation='lighter'`：`src/App.tsx:178-188`。
- 帧循环内无 `createRadialGradient`/`shadowBlur`/`save`/`restore`（grep 仅命中 `bakeSprite` 与注释）。
- 视觉等价截图（同视口 1280×800、同等待 20s）：改造前 `docs/delivery/stage1-before-sprite.png`，改造后 `docs/delivery/stage2-after-sprite.png`，局部放大对比 `docs/delivery/compare-draw.png`（左前右后：白色核心 + 紫色辉光均保留）。

### 5. 画布尺寸（RO 单一写入源 + DPR 钳制 + setTransform）
- 唯一写入源 `applySize`：`src/App.tsx:95-106`（`min(devicePixelRatio,2)`、尺寸真变才赋值、`setTransform(dpr,...)`）。
- ResizeObserver 注册 `src/App.tsx:109-110`；同步 `applySize()` 初始化（`src/App.tsx:108`）消除 RO 首回调与首帧竞态。
- 帧循环（`src/App.tsx:146-189`）内无 `canvas.width/height` 赋值（grep 仅命中 `applySize`）。

### 6. React 边界
- 粒子 buffer 不进 state：组件仅 `canvasRef`/`hudRef` 两个 ref（`src/App.tsx:73-74`），`latest` 是 effect 局部变量（`src/App.tsx:84`）；`grep -n 'useState' src/` 无结果。
- fps 为真实帧间隔滑动均值（rAF 时间戳，500ms 窗）：`src/App.tsx:156-162`；以 250ms（4Hz）节流直写 `textContent`：`src/App.tsx:163-166`。

### 7. 生命周期（暂停与恢复）
- `visibilitychange`：`src/App.tsx:114-118`；`IntersectionObserver`：`src/App.tsx:119-123`；暂停时停发 tick（`src/App.tsx:170`），Worker 无请求即空转。
- 恢复时 `lastT = -1` 重置时间基准 + `dt` 钳制 ≤100ms（`src/App.tsx:149`），防追帧跳变。

### 8. 兼容（module worker 探测 + classic 降级）
- 能力探测（MDN 式 getter 探针）：`src/App.tsx:43-57`；构造 try/catch 回退：`src/App.tsx:59-70`。
- classic 入口 `src/workers/sim.classic.worker.ts` 与 module 入口复用 `src/workers/sim-core.ts` 同一实现；经 Vite 静态 `new URL(..., import.meta.url)` 引用，生产构建产出独立 iife chunk（`dist/assets/sim.classic.worker-kNC9fPpW.js`，首行 `(function(){`，无 `import` 语句），非运行时拼 `.ts` 路径。
- 实测：在生产构建页面内直接 `new Worker('/assets/sim.classic.worker-*.js')` 发 init+tick，收到 `frame` 且 `view` 为 4800 长度 `Float32Array`、19200 字节 buffer 经 transfer 到达。

## 遗留风险

- sprite 辉光为固定形状，重叠处加法混合与原 `shadowBlur` 观感存在细微差异（见对比图，可接受）；如需逐粒子异半径辉光须回到更贵路径。
- `'lighter'` 在极密集重叠时核心会饱和为纯白（原实现 source-over 叠加亦趋近饱和）。
- classic 降级路径已在 Chromium 验证功能等价，但未在真实旧版 Safari/Firefox 真机回归（探测逻辑为 MDN 标准模式）。
- `performance.memory` 仅 Chromium 可用，内存结论建议再以 DevTools Allocation timeline 复核。
