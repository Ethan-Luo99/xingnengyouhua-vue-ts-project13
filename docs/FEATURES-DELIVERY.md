# 功能扩展交付说明（交互控制 / 确定性回放 / 可变规模）

在已完成性能重构的 1200→可变粒子 Canvas 应用上做功能扩展。**全部既有不变量原样保留**：
1 条 rAF 链、1 个 Worker、Transferable 单壳乒乓、拉模式在途请求恒 ≤1、ResizeObserver 单一写入源、
module/classic 双入口。`package.json`/`package-lock.json` 未改、未新增任何 npm 依赖、未改任何既有文档、
未执行任何 git 操作。

改动文件（仅 3 个）：

- `src/workers/protocol.ts`：新增档位/倍速/斥力常量与 ring 容量；扩展消息协议（tick 增加
  `steps`/`force`，新增 `seek`、`resize`；state 回传 `count/mode/oldestSeq/latestSeq`）。
- `src/workers/sim.worker.shared.ts`：物理纯函数化并加入斥力；多步长积分；定容滚动 ring 与
  seek；按档位显式回收重分配。
- `src/App.tsx`：零分配命令通道、暂停/单步/倍速控制、回放滑块与档位按钮、HUD 扩展、事件 cleanup。

## 一、交互力场（零分配命令通道）

- 指针按下/拖拽（Pointer Events，统一鼠标与触摸，`touchAction:'none'`）产生斥力，抬起/取消即关。
- 命令对象 `forceCommand` 在挂载时分配一次并挂在常驻复用的 `tickMessage.force` 上，
  逐帧只覆写 `active/x/y` 标量（`radius/strength` 常量），**禁止每帧新建命令对象**。
- 斥力在 Worker `physics()` 内按距离平方在半径内施加平滑径向推开（固定 epsilon 防除零）。

## 二、暂停 / 单步 / 倍速

- 暂停：手动暂停与既有「页面隐藏/滚出视口」生命周期暂停取或；暂停时不发 tick，在途自然归零。
- 单步：仅在手动暂停下有效，显式绕过暂停门控推进一步，`seq += 1`。
- 倍速 `0.25×/1×/4×`：通过「每帧执行多次固定步长积分」实现——4× 每帧恒定 4 步、
  1× 每帧 1 步、0.25× 用累加器每 4 帧出 1 步；**一个 rAF 仍只发一个 tick 请求（携带 `steps`），在途仍 ≤1**。

## 三、确定性回放

- Worker 维护定容滚动 ring（`RING_CAPACITY=120` 帧，每帧完整状态，Float32 定容存储），
  仅在 live 推演时写入；replay 分叉推演不污染 live 时间线。
- `seek {seq,mode}`：恢复到任意已记录 seq 并继续推演；`replay` 停在该点，`live` 重置时间线继续。
- **物理完全纯函数化**：无 `Math.random`、无 `Date.now`，仅依赖 `(state, tick, force)`。
  已验证同一 seq 的「首次记录帧」与「从最旧帧重新单步推演帧」画布像素 hash **逐位一致**。
- 覆盖目标确定行为：`target<oldest` clamp 到最旧、`target>latest` clamp 到最新，不崩溃、不脏读。

## 四、可变规模（2000 / 8000 / 20000）

- `resize` 走显式回收路径 `resetSimulation`：旧权威/壳/ring 引用先置零（零长视图断开、不可再写），
  再按新档位重分配；旧壳随 resize 请求 transfer 回 Worker 丢弃，新壳在响应中带回，
  **切换瞬间无旧 buffer 泄漏、无 detached 写入**。切换后 ring 重置为 seq0 单帧，HUD/绘制粒子数随档更新。
- 档位切换进行中屏蔽 seek，避免跨尺寸壳混用；resize 优先级最高，帧内最多一个请求。

## 五、HUD 与不变量核对（headless 实测）

- HUD 实时显示：fps / 帧时 / particles / **seq / mode(live|replay) / speed** / running|paused。
- 1 个 Worker：StrictMode 双挂载、reload 重挂、档位切换后 CDP worker target 恒为 1（module），无 page error。
- 稳态零新增对象：稳态 2s hook 统计主线程与 Worker 的 `Float32Array/ArrayBuffer` 构造均为 0。
- seek/ring：暂停后滑块在 120 帧窗口内取点正确进入 replay，回 live 后窗口重置为单帧；无错误。
- `npm run build`（`tsc -b && vite build`）与 `npm run lint` 均零错误/零告警。

## 他人如何手动验证（≤200 字）

`npm run dev` 打开页面。1.看左上 HUD 有 seq/mode/speed。2.在画布按住拖动，粒子被向四周推开，松手复原。3.点暂停画面静止，连点单步 seq 每次 +1；点继续恢复。4.依次点 4x（seq 增长约 4 倍速）、0.25x（明显变慢）、1x。5.点暂停，拖动右上回放滑块到任意 seq，HUD 变 replay、画面回到该帧；点回到 live 恢复实时。6.依次点 2000/8000/20000，粒子数随档变化且无报错，再切回 2000。全程无崩溃、无控制台错误。
