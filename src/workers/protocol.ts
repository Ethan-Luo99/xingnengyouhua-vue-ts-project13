export const PARTICLE_FLOATS = 4
export const PARTICLE_COUNT = 1200
export const BUFFER_FLOATS = PARTICLE_COUNT * PARTICLE_FLOATS

export type SimTickRequest = {
  type: 'tick'
  seq: number
  // main 归还的传输壳视图（随其 buffer 一起 transfer）；接收端可直接读写，无需再包视图。
  recycle?: Float32Array<ArrayBuffer>
}

export type SimReadyMessage = {
  type: 'ready'
}

export type SimStateMessage = {
  type: 'state'
  seq: number
  particles: Float32Array<ArrayBuffer>
}

export type SimWorkerMessage = SimReadyMessage | SimStateMessage
