# 功能扩展交付说明（交互力场 / 回放 / 可变规模 / HUD）

在已完成性能重构的 1200 粒子应用上做两阶段功能扩展。既有架构与全部不变量原样保留：
**全应用 1 条 rAF 链、1 个 Worker、Transferable 单壳乒乓、拉模式在途请求恒 ≤1、
ResizeObserver 单一写入源、稳态主线程与 Worker 零新增对象分配、StrictMode/重挂/HMR 不泄漏。**

- 未改 `package.json` / `package-lock.json`，未引入任何依赖；未改动 `docs/` 下任何已有文档；未执行任何 git 操作。
- 仅改动 3 个源文件：`src/workers/protocol.ts`、`src/workers/sim.worker.shared.ts`、`src/App.tsx`。

## 分阶段落地（每阶段 `npm run build` 零错误）

- 阶段① 交互与控制协议：斥力场命令通道、暂停 / 单步 / 倍速；阶段①构建通过后再进入阶段②。
- 阶段② 确定性回放（ring buffer + seek）、可变规模（显式回收路径）、HUD 扩展。

## 1. 交互力场（零分配复用命令通道）

- 指针/触摸统一走 Pointer Events（`pointerdown/move/up/cancel` + `setPointerCapture`），
  按下拖拽时记录 `force {x,y,active}`，移动只写标量、零对象。
- 力参数（位置、半径 `FORCE_RADIUS=150`、强度 `FORCE_STRENGTH=0.9`）复用在**同一个常驻
  tick 消息对象**的标量字段上随帧下发（`forceX/forceY/forceRadius/forceStrength`），
  不新建命令对象、不新增 transfer。
- Worker `physics` 在半径内按距离衰减施加归一化方向斥力；重合点用确定方向 `(1,0)`，禁除零。

## 2. 暂停 / 单步 / 倍速（在途仍 ≤1）

- 暂停：复用既有「不发 tick」语义（保留页面隐藏/滚出的自动暂停），另加用户暂停。
- 单步：暂停或 replay 停住时也可触发一拍，推演恰好 1 个固定步长。
- 倍速：`1×`=1 步/帧；`4×`=**同一请求内执行 4 次固定步长积分**（只发 1 个 tick、回 1 条状态，在途恒 ≤1）；
  `0.25×`=主线程 0.25 累加器跨帧取 0/1 步，约每 4 帧 1 步。
- 多步使用各自真实 tick 序号驱动，因此与逐帧推演逐位一致。

## 3. 确定性回放（定容滚动 ring buffer）

- Worker 内单块定容 `ArrayBuffer` + 预切槽视图（`KEYFRAME_CAPACITY=120` 关键帧），
  稳态只 `slot.set`，零新增对象；约保留最近 2s（60fps×步长）。
- 关键帧逻辑序号恒等于仿真 seq（初始帧 seq=0，每固定步长 +1），物理槽位 `seq % CAP`，
  另维护 `oldestSeq`。
- 物理纯函数化：驱动仅 `sin/cos`，全链路禁 `Math.random`、禁 `Date.now`；
  seek 后从该关键帧状态继续推演，同一 seq 与首次运行逐位一致。
- seek：主线程发复用的 `seek` 命令（仍走单壳乒乓、在途 ≤1）；Worker 对目标做
  **确定性 clamp**——被滚动覆盖则落到最旧可用帧 `oldestSeq`，超过最新则落到 `liveEdge`；
  只读有效槽，不崩溃、不读脏数据。落点即截断更新的逻辑历史，后续逐槽原地覆盖。
- 拖滑块自动暂停；落不到最新帧进入 `replay`（停住等待），点「继续 / 回到实时」从落点继续推演。

## 4. 可变规模（显式回收，不泄漏 / 不写 detached）

- 三档 2000 / 8000 / 20000 运行时切换，发复用的 `resize` 命令，仍在单在途槽内（≤1）。
- Worker 走**显式回收路径** `reallocate(count, recycled)`：用新 ArrayBuffer 替换
  权威缓冲与整块 ring（旧引用立即释放），重写 seq=0 确定性初始关键帧。
- 旧传输壳按字节长度判定：尺寸一致则复用；不一致则确定性丢弃并按新尺寸另配，
  **不向 detached 缓冲写入**。主线程对「尺寸不符被丢弃」的旧壳不放入 transfer list，
  且 tick/seek/resize 各自使用独立复用的 transfer 数组，避免被转移的旧 buffer 污染后续回复。
- 切档为确定性重置（seq 归 0、HUD 粒子数随回复更新）；切换瞬间无旧 buffer 泄漏。

## 5. HUD 与控件

- HUD（≤4Hz 直写 `textContent`，无逐帧 React 提交）扩展为：
  `fps / 帧时 / seq / mode(live|replay) / speed / particles`，暂停追加 `/ paused`。
- 底部控件：暂停/继续、单步、0.25×/1×/4×、回放拖动条（min 随滚动前移=最旧可用 seq）、
  2k/8k/20k 档位、回到实时。
- 低频控件用 React state 呈现，rAF 侧读 effect 内本地镜像；命令式 API 挂在 ref，cleanup 置空。

## 不变量与清理

- cleanup 覆盖：`cancelAnimationFrame`、ResizeObserver/IntersectionObserver `disconnect`、
  `visibilitychange` 与 4 个指针监听移除、`worker.onmessage=null` + `terminate()`、
  显示壳与命令式 API 置空。
- headless 实测：StrictMode 双挂载 worker「创建 2 / 存活 1」、卸载后 0；
  连续 2 次 HMR 后仍仅 1 个 worker、HUD 正常；稳态 1.2s 主线程 `Float32Array/ArrayBuffer` 分配均为 0；
  斥力拖拽、暂停、单步(+1)、0.25×/4×、seek clamp 到最旧帧、三档切换与重放继续全程无 page error。

---

## 他人如何手动验证（≤200 字）

`npm install && npm run dev` 打开页面：① 画布上按住拖动，附近粒子被推开，松手恢复。
② 点 4× 粒子明显变快、0.25× 变慢；点暂停画面与 seq 静止，点单步 seq 恰增 1。
③ 运行约 3 秒后拖底部「回放」滑块：HUD 变 mode replay，画面回到该帧；滑块左端是最旧可用帧，
往左拉到底会停在最旧帧（不报错）；点继续则从该点继续。④ 点 2k/8k/20k，粒子密度与 HUD particles
即时变化、seq 归零并继续增长。全程看左上角 HUD 的 seq/mode/speed/particles 同步更新，
刷新、切后台再回来无卡死、无报错。
