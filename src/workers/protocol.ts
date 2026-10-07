export const PARTICLE_FLOATS = 4

// 默认规模（保留既有 1200 启动观感）；运行时在 SIZE_TIERS 间切换。
export const DEFAULT_PARTICLE_COUNT = 1200
export const SIZE_TIERS = [2000, 8000, 20000] as const

// 确定性回放：定容滚动关键帧数（每关键帧为一份完整粒子快照）。
// 60fps 下约保留最近 2s；20k 档环形存储约 38.4 MiB，仅在切换时一次性分配。
export const KEYFRAME_CAPACITY = 120

export type SpeedTier = 0.25 | 1 | 4
export type SimMode = 'live' | 'replay'

// 主 -> Worker：tick（逐帧稳态消息）/ seek（回放跳转）/ resize（显式重分配）。
// 三者的消息对象与共用 transfer 数组在主线程全程复用，禁止每帧新建。
export type SimTickRequest = {
  type: 'tick'
  seq: number
  // 本帧执行的固定步长积分次数（1 / 4；0.25x 时由主线程在多帧间取 0/1）。
  // 仍是一个请求 -> 至多一条状态回复，在途恒 <=1。
  steps: number
  // 复用命令通道：按下拖拽时非零；全部为标量，随 tick 一起结构化克隆，
  // 不产生每帧命令对象。
  forceX: number
  forceY: number
  forceRadius: number
  forceStrength: number
  // main 归还的传输壳视图（随其 buffer 一起 transfer）；接收端可直接读写。
  recycle?: Float32Array<ArrayBuffer>
}

export type SimSeekRequest = {
  type: 'seek'
  // 目标 seq；被滚动覆盖时 worker 确定性 clamp 到最旧可用关键帧。
  seq: number
  // seek 同样需要壳回传快照：main 把当前显示壳随 buffer transfer 回来。
  recycle?: Float32Array<ArrayBuffer>
}

export type SimResizeRequest = {
  type: 'resize'
  // 新粒子数；旧权威/环形缓冲在 worker 内走显式回收路径，旧壳按尺寸决定复用/丢弃。
  count: number
  // 若 main 手里有旧壳则一并归还（尺寸不符时 worker 确定性丢弃并新配）。
  recycle?: Float32Array<ArrayBuffer>
}

export type SimMainRequest = SimTickRequest | SimSeekRequest | SimResizeRequest

export type SimReadyMessage = {
  type: 'ready'
  count: number
}

export type SimStateMessage = {
  type: 'state'
  // 该回复对应哪条命令（HUD 模式与 React 低频同步用）。
  kind: 'tick' | 'seek' | 'resize'
  // 当前快照对应的 seq（seek 为 clamp 后实际落点）。
  seq: number
  // worker 权威缓冲最新已推演到的 seq。
  liveEdge: number
  // 环形缓冲当前最旧可用 seq（滚动覆盖后增大）。
  oldestSeq: number
  // seek 落点是否就是最新帧（true 时 main 仍计为 live 模式）。
  atEdge: boolean
  count: number
  particles: Float32Array<ArrayBuffer>
}

export type SimWorkerMessage = SimReadyMessage | SimStateMessage

export function byteLengthFor(count: number): number {
  return count * PARTICLE_FLOATS * 4
}
