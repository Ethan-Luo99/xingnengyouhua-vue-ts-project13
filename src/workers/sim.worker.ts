const DAMPING = 0.995
const COUNT = 1200

function physics(state: Float32Array<ArrayBuffer>, tick: number) {
  for (let i = 0; i < COUNT; i++) {
    const vx = state[i * 4 + 2]
    const vy = state[i * 4 + 3]
    state[i * 4] += vx
    state[i * 4 + 1] += vy
    state[i * 4 + 2] = (vx + Math.sin(tick + i) * 0.01) * DAMPING
    state[i * 4 + 3] = (vy + Math.cos(tick + i) * 0.01) * DAMPING
  }
  return state
}

let buf = new Float32Array(COUNT * 4)

self.onmessage = (e: MessageEvent<{ tick: number; count: number }>) => {
  const { tick } = e.data
  buf = physics(buf, tick)
  const copy = new Float32Array(buf)
  self.postMessage(copy)
}
