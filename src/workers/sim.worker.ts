import { BUFFER_FLOATS, type SimStateMessage, type SimTickRequest } from './protocol'

const DAMPING = 0.995
const BYTE_LENGTH = BUFFER_FLOATS * 4

function physics(state: Float32Array<ArrayBuffer>, tick: number) {
  for (let i = 0; i < state.length / 4; i++) {
    const vx = state[i * 4 + 2]
    const vy = state[i * 4 + 3]
    state[i * 4] += vx
    state[i * 4 + 1] += vy
    state[i * 4 + 2] = (vx + Math.sin(tick + i) * 0.01) * DAMPING
    state[i * 4 + 3] = (vy + Math.cos(tick + i) * 0.01) * DAMPING
  }
}

// Transferable 单壳乒乓。全程仅在模块初始化时分配：
//   - 权威缓冲：仿真状态的唯一写者，永远留在 worker（视图常驻，永不 detach）；
//   - 传输壳缓冲（19200 字节）：在 worker/main 间逐帧转移所有权、循环复用，不重新分配。
// 稳态每帧应用层零新增对象：消息对象、transfer 数组均复用；回收壳以「视图随 buffer
// 一起 transfer」方式回到 worker，接收端直接得到可用 Float32Array，无需再包一层视图。
// 绝不对已转移（detached）缓冲写入（规避全零帧陷阱）。
const authorityView = new Float32Array(new ArrayBuffer(BYTE_LENGTH))
let shellView: Float32Array<ArrayBuffer> | null = new Float32Array(
  new ArrayBuffer(BYTE_LENGTH),
)

const stateMessage: SimStateMessage = { type: 'state', seq: 0, particles: authorityView }
const transferList: Transferable[] = []

type WorkerGlobalScope = {
  onmessage: ((e: MessageEvent<SimTickRequest>) => void) | null
  postMessage(message: SimStateMessage, transfer: Transferable[]): void
}
const workerGlobal = globalThis as unknown as WorkerGlobalScope

workerGlobal.onmessage = (e: MessageEvent<SimTickRequest>) => {
  const msg = e.data
  if (msg.type !== 'tick') return

  // main 归还的传输壳视图（内容为上一帧快照）；取回作为本帧输出壳。
  if (msg.recycle) shellView = msg.recycle
  const shell = shellView
  if (!shell) return // 拉模式在途 <=1：tick 到达时壳必已归还

  // 权威状态原地推进一个固定步长（seq 为帧序号），再零分配快照进传输壳。
  physics(authorityView, msg.seq)
  shell.set(authorityView)
  shellView = null

  stateMessage.seq = msg.seq
  stateMessage.particles = shell
  transferList[0] = shell.buffer
  workerGlobal.postMessage(stateMessage, transferList)
}
