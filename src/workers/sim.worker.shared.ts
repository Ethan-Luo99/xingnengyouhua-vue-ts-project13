import {
  DEFAULT_PARTICLE_COUNT,
  PARTICLE_FLOATS,
  PARTICLE_TIERS,
  RING_CAPACITY,
  type SimMainMessage,
  type SimStateMessage,
} from './protocol'

const DAMPING = 0.995
const MAX_TIER = PARTICLE_TIERS[PARTICLE_TIERS.length - 1]

// 物理纯函数：仅依赖 (state, tick, force)，禁 Math.random / Date.now，
// 同一 seq、同一力参数下重放逐位一致。一个固定步长原地推进。
function physics(
  state: Float32Array<ArrayBuffer>,
  count: number,
  tick: number,
  forceActive: number,
  forceX: number,
  forceY: number,
  forceRadius: number,
  forceStrength: number,
) {
  const radiusSq = forceRadius * forceRadius
  for (let i = 0; i < count; i++) {
    const base = i * PARTICLE_FLOATS
    let vx = state[base + 2]
    let vy = state[base + 3]
    vx += Math.sin(tick + i) * 0.01
    vy += Math.cos(tick + i) * 0.01
    if (forceActive !== 0) {
      const dx = state[base] - forceX
      const dy = state[base + 1] - forceY
      const distSq = dx * dx + dy * dy
      if (distSq < radiusSq) {
        // 圆内平滑斥力：越靠近指针越强，固定 epsilon 避免除零。
        const falloff = 1 - Math.sqrt(distSq) / forceRadius
        const inv = 1 / Math.sqrt(distSq + 0.01)
        const push = forceStrength * falloff
        vx += dx * inv * push
        vy += dy * inv * push
      }
    }
    vx *= DAMPING
    vy *= DAMPING
    state[base] += vx
    state[base + 1] += vy
    state[base + 2] = vx
    state[base + 3] = vy
  }
}

type SimWorkerScope = {
  onmessage: ((e: MessageEvent<SimMainMessage>) => void) | null
  postMessage(message: SimStateMessage | { type: 'ready' }, transfer: Transferable[]): void
}

// module 与 classic 两个入口共用同一份引导，避免重复实现物理与乒乓逻辑。
export function bootstrapSimWorker(): void {
  const scope = globalThis as unknown as SimWorkerScope

  // 权威缓冲（仿真唯一写者，永不离线程）+ 单壳传输缓冲（逐帧转移所有权复用）。
  // 初始为零长占位；唯一分配点是 resetSimulation（含启动与每次档位切换），
  // 切换走显式回收：旧引用先置零再重分配，杜绝旧 buffer 泄漏 / detached 写入。
  let count = 0
  let floats = 0
  let byteLength = 0
  let authorityView: Float32Array<ArrayBuffer> = new Float32Array(
    new ArrayBuffer(0),
  )
  let shellView: Float32Array<ArrayBuffer> | null = null

  // 确定性回放：定容滚动 ring（最近 RING_CAPACITY 个固定步长关键帧）。
  // 仅在 live 推演时写入；replay 分叉推演不污染 live 时间线。
  let ringStorage: Float32Array<ArrayBuffer> = new Float32Array(
    new ArrayBuffer(0),
  )
  let ringCount = 0
  let ringHead = 0
  let ringLatestSeq = 0
  let authoritySeq = 0
  let mode: 'live' | 'replay' = 'live'

  const stateMessage: SimStateMessage = {
    type: 'state',
    seq: 0,
    count,
    mode,
    oldestSeq: 0,
    latestSeq: 0,
    particles: authorityView,
  }
  const transferList: Transferable[] = []

  // 关键帧写入（仅 live 路径）：set 带目标偏移，稳态零新增对象。
  const recordKeyframe = (keySeq: number) => {
    ringStorage.set(authorityView, ringHead * floats)
    ringHead = (ringHead + 1) % RING_CAPACITY
    if (ringCount < RING_CAPACITY) ringCount += 1
    ringLatestSeq = keySeq
  }

  const resetSimulation = (nextCount: number) => {
    // 显式回收：先丢弃旧 buffer（零长视图断开引用，供 GC 回收且不可再写），
    // 再按新档位重分配；切换瞬间旧壳也已随 resize 请求 transfer 回此处置空。
    authorityView = new Float32Array(0)
    shellView = null
    ringStorage = new Float32Array(0)
    count = nextCount
    floats = count * PARTICLE_FLOATS
    byteLength = floats * 4
    authorityView = new Float32Array(new ArrayBuffer(byteLength))
    shellView = new Float32Array(new ArrayBuffer(byteLength))
    ringStorage = new Float32Array(
      new ArrayBuffer(RING_CAPACITY * floats * 4),
    )
    ringCount = 0
    ringHead = 0
    authoritySeq = 0
    mode = 'live'
    // seq 0 初始关键帧（全零确定初态），保证任意时刻至少有一帧可 seek。
    recordKeyframe(0)
  }

  resetSimulation(DEFAULT_PARTICLE_COUNT)

  // live ring 记录连续 seq：最旧帧 = 最新帧 - 已帧数 + 1（resize/seek 重置后同样成立）。
  const oldestSeq = () => ringLatestSeq - ringCount + 1
  // 最新帧位于 head-1 槽；目标帧按与最新帧的距离回退。
  const ringIndexOf = (keySeq: number) =>
    (ringHead - 1 - (ringLatestSeq - keySeq) + RING_CAPACITY) % RING_CAPACITY

  const sendState = (shell: Float32Array<ArrayBuffer>) => {
    stateMessage.seq = authoritySeq
    stateMessage.count = count
    stateMessage.mode = mode
    stateMessage.oldestSeq = oldestSeq()
    stateMessage.latestSeq = ringLatestSeq
    stateMessage.particles = shell
    transferList[0] = shell.buffer
    scope.postMessage(stateMessage, transferList)
  }

  const handleTick = (msg: Extract<SimMainMessage, { type: 'tick' }>) => {
    if (msg.recycle) shellView = msg.recycle
    const shell = shellView
    if (!shell) return // 拉模式在途 <=1：tick 到达时壳必已归还

    // 倍速：一个 rAF tick 内 steps 次固定步长积分，不额外发请求。
    const force = msg.force
    let tick = msg.seq - msg.steps
    for (let s = 0; s < msg.steps; s++) {
      tick += 1
      physics(
        authorityView,
        count,
        tick,
        force.active,
        force.x,
        force.y,
        force.radius,
        force.strength,
      )
      authoritySeq = tick
      if (mode === 'live') recordKeyframe(tick)
    }

    shell.set(authorityView)
    shellView = null
    sendState(shell)
  }

  const handleSeek = (msg: Extract<SimMainMessage, { type: 'seek' }>) => {
    if (msg.recycle) shellView = msg.recycle
    const shell = shellView
    if (!shell) return

    // 覆盖目标 clamp 到最旧可用帧：确定行为，不崩溃、不脏读。
    let target = msg.seq
    if (target < oldestSeq()) target = oldestSeq()
    if (target > ringLatestSeq) target = ringLatestSeq

    const start = ringIndexOf(target) * floats
    authorityView.set(ringStorage.subarray(start, start + floats))
    authoritySeq = target
    mode = msg.mode

    if (mode === 'live') {
      // 回到实时时间线：重置 ring 为单帧（target 置于槽 0，head 指向下一写入槽）。
      ringHead = 1
      ringCount = 1
      ringLatestSeq = target
      ringStorage.set(authorityView, 0)
    }

    shell.set(authorityView)
    shellView = null
    sendState(shell)
  }

  const handleResize = (msg: Extract<SimMainMessage, { type: 'resize' }>) => {
    const nextCount = Math.max(1, Math.min(MAX_TIER, Math.round(msg.count)))
    resetSimulation(nextCount)
    // 壳在 resetSimulation 内已重分配：直接快照权威初态并转移给 main。
    const shell = shellView
    if (!shell) return
    shell.set(authorityView)
    shellView = null
    sendState(shell)
  }

  scope.postMessage({ type: 'ready' }, [])

  scope.onmessage = (e: MessageEvent<SimMainMessage>) => {
    const msg = e.data
    if (msg.type === 'tick') handleTick(msg)
    else if (msg.type === 'seek') handleSeek(msg)
    else if (msg.type === 'resize') handleResize(msg)
  }
}
