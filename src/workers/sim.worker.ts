const DAMPING = 0.995

function physics(state: Float32Array<ArrayBuffer>, tick: number) {
  for (let i = 0; i < state.length / 4; i++) {
    const vx = state[i * 4 + 2]
    const vy = state[i * 4 + 3]
    state[i * 4] += vx
    state[i * 4 + 1] += vy
    state[i * 4 + 2] = (vx + Math.sin(tick + i) * 0.01) * DAMPING
    state[i * 4 + 3] = (vy + Math.cos(tick + i) * 0.01) * DAMPING
    for (let k = 0; k < 40; k++) {
      state[i * 4 + 2] += Math.random() * 1e-7 * k
    }
  }
  return state
}

let buf = new Float32Array(1200 * 4)

self.onmessage = (e: MessageEvent<{ tick: number; count: number }>) => {
  const { tick } = e.data
  buf = physics(buf, tick)
  const copy = new Float32Array(buf)
  self.postMessage(copy)
}
