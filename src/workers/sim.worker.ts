export type MainToWorker =
  | { type: 'init'; count: number }
  | { type: 'tick'; tick: number }
  | { type: 'recycle'; buffer: ArrayBuffer }

export type WorkerToMain = {
  type: 'frame'
  tick: number
  view: Float32Array<ArrayBuffer>
}

const DAMPING = 0.995
const STRIDE = 4

// 仿真权威状态，所有权永远留在 Worker，绝不 transfer
let state = new Float32Array(0)
// 可复用的空闲快照缓冲（乒乓池），稳态在 2 块之间流转
const spare: ArrayBuffer[] = []

function physics(tick: number) {
  const n = state.length / STRIDE
  for (let i = 0; i < n; i++) {
    const vx = state[i * STRIDE + 2]
    const vy = state[i * STRIDE + 3]
    state[i * STRIDE] += vx
    state[i * STRIDE + 1] += vy
    state[i * STRIDE + 2] = (vx + Math.sin(tick + i) * 0.01) * DAMPING
    state[i * STRIDE + 3] = (vy + Math.cos(tick + i) * 0.01) * DAMPING
  }
}

self.onmessage = (e: MessageEvent<MainToWorker>) => {
  const msg = e.data
  if (msg.type === 'init') {
    state = new Float32Array(msg.count * STRIDE)
    spare.length = 0
    spare.push(new ArrayBuffer(state.byteLength), new ArrayBuffer(state.byteLength))
    return
  }
  if (msg.type === 'recycle') {
    spare.push(msg.buffer)
    return
  }
  if (msg.type === 'tick') {
    // 拉模式：主线程在途请求 ≤1，正常路径下 spare 恒非空；
    // 若异常为空则丢弃本拍，仿真自然降速而不是堆积
    const buffer = spare.pop()
    if (!buffer) return
    physics(msg.tick)
    const view = new Float32Array(buffer)
    view.set(state)
    const frame: WorkerToMain = { type: 'frame', tick: msg.tick, view }
    self.postMessage(frame, { transfer: [buffer] })
  }
}
