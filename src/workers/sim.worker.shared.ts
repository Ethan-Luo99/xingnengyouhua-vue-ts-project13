import {
  byteLengthFor,
  DEFAULT_PARTICLE_COUNT,
  KEYFRAME_CAPACITY,
  type SimMainRequest,
  type SimStateMessage,
  type SimWorkerMessage,
} from './protocol'

const DAMPING = 0.995

// 物理：确定性纯函数。驱动只允许 sin/cos（禁 Math.random、禁 Date.now）；
// 同一 (state, tick, force*) 输入逐位得到同一结果，保证 seek 后重放与首跑一致。
function physics(
  state: Float32Array<ArrayBuffer>,
  tick: number,
  forceX: number,
  forceY: number,
  forceRadius: number,
  forceStrength: number,
): void {
  const radiusSq = forceRadius * forceRadius
  const applyForce = forceStrength !== 0 && radiusSq > 0
  for (let i = 0; i < state.length / 4; i++) {
    const ix = i * 4
    let x = state[ix]
    let y = state[ix + 1]
    let vx = state[ix + 2]
    let vy = state[ix + 3]

    if (applyForce) {
      const dx = x - forceX
      const dy = y - forceY
      const distSq = dx * dx + dy * dy
      if (distSq < radiusSq) {
        // 距离越近斥力越强；方向归一化，magnitude <= forceStrength。
        const falloff = 1 - distSq / radiusSq
        // 完全重合时用确定方向（(1,0)），禁除零、禁随机。
        const invDist = distSq > 1e-6 ? 1 / Math.sqrt(distSq) : 1
        const impulse = forceStrength * falloff
        vx += dx * invDist * impulse
        vy += dy * invDist * impulse
      }
    }

    vx += Math.sin(tick + i) * 0.01
    vy += Math.cos(tick + i) * 0.01
    vx *= DAMPING
    vy *= DAMPING
    x += vx
    y += vy

    state[ix] = x
    state[ix + 1] = y
    state[ix + 2] = vx
    state[ix + 3] = vy
  }
}

type SimWorkerScope = {
  onmessage: ((e: MessageEvent<SimMainRequest>) => void) | null
  postMessage(message: SimWorkerMessage, transfer: Transferable[]): void
}

// module 与 classic 两个入口共用同一份引导。
export function bootstrapSimWorker(): void {
  const scope = globalThis as unknown as SimWorkerScope

  let particleCount = DEFAULT_PARTICLE_COUNT
  // 权威缓冲：仿真状态唯一写者，永远留在 worker（视图常驻，永不 detach）。
  let authorityView: Float32Array<ArrayBuffer> = new Float32Array(
    new ArrayBuffer(byteLengthFor(particleCount)),
  )
  // 传输壳缓冲：在 worker/main 间逐帧转移所有权、循环复用。
  let shellView: Float32Array<ArrayBuffer> | null = new Float32Array(
    new ArrayBuffer(byteLengthFor(particleCount)),
  )

  // --- 定容滚动 ring buffer（确定性回放）---
  // 单块连续 ArrayBuffer + 预切槽视图；稳态只 slot.set，零新增对象。
  // ringHead：最旧关键帧所在物理槽；ringCount：有效帧数（<= CAP）。
  // 关键帧逻辑序号恒等于其仿真 seq（初始帧 seq=0，之后每固定步长 +1），
  // 故物理槽 = seq % CAP；最旧 seq 单独维护（oldestSeq）。
  // ringBuffer 在 allocateRing 中一次性定容分配（启动时），稳态零分配。
  let ringBuffer: ArrayBuffer = new ArrayBuffer(0)
  let slotViews: Float32Array<ArrayBuffer>[] = []
  let ringHead = 0
  let ringCount = 0
  let liveEdge = 0
  let oldestSeq = 0

  const allocateRing = (count: number) => {
    ringBuffer = new ArrayBuffer(byteLengthFor(count) * KEYFRAME_CAPACITY)
    slotViews = new Array(KEYFRAME_CAPACITY)
    const floats = count * 4
    const bytes = byteLengthFor(count)
    for (let slot = 0; slot < KEYFRAME_CAPACITY; slot++) {
      slotViews[slot] = new Float32Array(ringBuffer, slot * bytes, floats)
    }
    ringHead = 0
    ringCount = 0
    liveEdge = 0
    oldestSeq = 0
  }

  // 记录当前权威状态为关键帧（每固定步长一次；4x 一拍 4 条）。
  const recordKeyframe = () => {
    const slot = (ringHead + ringCount) % KEYFRAME_CAPACITY
    slotViews[slot].set(authorityView)
    if (ringCount === KEYFRAME_CAPACITY) {
      // 已满：整体滚动，最旧帧被覆盖，oldestSeq 确定前移。
      ringHead = (ringHead + 1) % KEYFRAME_CAPACITY
      oldestSeq += 1
    } else {
      ringCount += 1
    }
  }

  // 显式回收/重分配路径（初始化与 resize 共用）：
  // 旧权威/环形缓冲引用被新分配替换即确定性回收；旧壳尺寸不符时同样就地丢弃，
  // 由 GC 回收，绝不留下 detached 视图被写入。
  const reallocate = (
    count: number,
    recycled: Float32Array<ArrayBuffer> | undefined,
  ) => {
    particleCount = count
    authorityView = new Float32Array(new ArrayBuffer(byteLengthFor(count)))
    allocateRing(count)
    // 确定性初始态（全零；纯算术，无随机/时钟）。
    recordKeyframe()

    const wantBytes = byteLengthFor(count)
    if (recycled && recycled.byteLength === wantBytes) {
      shellView = recycled
    } else {
      // recycled 尺寸不符 -> 丢弃；无 recycled -> 丢弃旧 shellView 后新配。
      shellView = new Float32Array(new ArrayBuffer(wantBytes))
    }
  }

  const stateMessage: SimStateMessage = {
    type: 'state',
    kind: 'tick',
    seq: 0,
    liveEdge: 0,
    oldestSeq: 0,
    atEdge: false,
    count: particleCount,
    particles: authorityView,
  }
  const transferList: Transferable[] = []

  const sendState = (
    kind: 'tick' | 'seek' | 'resize',
    seq: number,
    atEdge: boolean,
  ) => {
    const shell = shellView
    if (!shell) return // 拉模式在途 <=1：命令到达时壳必已归还
    shell.set(authorityView) // 零分配快照；绝不对 detached 缓冲写入
    shellView = null
    stateMessage.kind = kind
    stateMessage.seq = seq
    stateMessage.liveEdge = liveEdge
    stateMessage.oldestSeq = oldestSeq
    stateMessage.atEdge = atEdge
    stateMessage.count = particleCount
    stateMessage.particles = shell
    transferList[0] = shell.buffer
    scope.postMessage(stateMessage, transferList)
  }

  // 初始化：权威/壳缓冲已按默认规模分配（字段初始化处，全程一次），
  // 只需定容环形缓冲并写入 seq=0 初始关键帧（确定性全零态）。
  allocateRing(particleCount)
  recordKeyframe()
  scope.postMessage({ type: 'ready', count: particleCount }, [])

  scope.onmessage = (e: MessageEvent<SimMainRequest>) => {
    const msg = e.data

    if (msg.type === 'resize') {
      // 旧壳随消息归还；尺寸不符则在 reallocate 内确定性丢弃。
      reallocate(msg.count, msg.recycle)
      sendState('resize', 0, true)
      return
    }

    if (msg.type === 'seek') {
      if (msg.recycle) shellView = msg.recycle

      // 确定性 clamp：目标被滚动覆盖 -> 最旧可用帧；超出最新 -> 最新帧。
      // 不崩溃、不读脏槽（只读 [oldestSeq..liveEdge] 内的有效物理槽）。
      const newest = liveEdge
      const target =
        msg.seq < oldestSeq
          ? oldestSeq
          : msg.seq > newest
            ? newest
            : msg.seq
      let offset = target - oldestSeq
      if (offset > ringCount - 1) offset = ringCount - 1
      const actualSeq = oldestSeq + offset
      const slot = (ringHead + offset) % KEYFRAME_CAPACITY
      authorityView.set(slotViews[slot])
      liveEdge = actualSeq
      // 逻辑截断：丢弃比落点更新的关键帧；从该点继续推演时逐槽原地覆盖。
      ringCount = offset + 1
      sendState('seek', actualSeq, actualSeq === newest)
      return
    }

    // tick：倍速=同一请求内执行多个固定步长（不是多发请求，在途仍 <=1）。
    if (msg.recycle) shellView = msg.recycle
    const steps = Math.max(1, msg.steps)
    for (let s = 0; s < steps; s++) {
      const stepTick = liveEdge + 1
      physics(
        authorityView,
        stepTick,
        msg.forceX,
        msg.forceY,
        msg.forceRadius,
        msg.forceStrength,
      )
      liveEdge = stepTick
      recordKeyframe()
    }
    sendState('tick', liveEdge, true)
  }
}
