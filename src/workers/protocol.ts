export const PARTICLE_FLOATS = 4
export const PARTICLE_COUNT = 1200
export const BUFFER_FLOATS = PARTICLE_COUNT * PARTICLE_FLOATS

// 可变规模三档（运行时切换，buffer 显式回收重分配）。
export const PARTICLE_TIERS = [2000, 8000, 20000] as const
export const DEFAULT_PARTICLE_COUNT = 2000

// 倍速档位：0.25x/1x/4x 通过「每帧执行多次固定步长积分」实现，在途请求仍 <=1。
export const SPEED_PRESETS = [0.25, 1, 4] as const
export const DEFAULT_SPEED = 1

// 交互斥力参数（canvas CSS 像素坐标，与 DPR 无关）。
export const FORCE_RADIUS = 140
export const FORCE_STRENGTH = 0.9

// Worker 内确定性回放 ring buffer：定容滚动，记录最近 RING_CAPACITY 个关键帧
// （每帧完整粒子状态 + seq）。被滚动覆盖的 seek 目标 clamp 到最旧可用帧。
export const RING_CAPACITY = 120

// 指针斥力命令：结构常驻复用，挂在 tick 消息上随帧下发。
// 稳态零新增对象：active/x/y/radius/strength 仅标量覆写，命令对象本身永不重建。
export type SimForceCommand = {
  active: number
  x: number
  y: number
  radius: number
  strength: number
}

export type SimTickRequest = {
  type: 'tick'
  seq: number
  steps: number
  force: SimForceCommand
  // main 归还的传输壳视图（随其 buffer 一起 transfer）；接收端可直接读写，无需再包视图。
  recycle?: Float32Array<ArrayBuffer>
}

export type SimSeekRequest = {
  type: 'seek'
  // 目标 seq；若已被 ring 滚动覆盖，worker clamp 到最旧可用帧，不崩溃不脏读。
  seq: number
  // live：从最旧可用帧之后的最新记录点恢复实时推演；replay：停在 seek 点继续推演。
  mode: 'live' | 'replay'
  recycle?: Float32Array<ArrayBuffer>
}

export type SimResizeRequest = {
  type: 'resize'
  count: number
  recycle?: Float32Array<ArrayBuffer>
}

export type SimMainMessage = SimTickRequest | SimSeekRequest | SimResizeRequest

export type SimReadyMessage = {
  type: 'ready'
}

export type SimStateMessage = {
  type: 'state'
  seq: number
  count: number
  mode: 'live' | 'replay'
  oldestSeq: number
  latestSeq: number
  particles: Float32Array<ArrayBuffer>
}

export type SimWorkerMessage = SimReadyMessage | SimStateMessage
