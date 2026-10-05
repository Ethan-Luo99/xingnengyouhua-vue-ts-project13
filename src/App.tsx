import { useEffect, useRef } from 'react'
import './App.css'

const COUNT = 1200
const OPACITY = 0.6
const HUD_INTERVAL_MS = 250
const FPS_WINDOW = 60

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const hudRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const worker = new Worker(
      new URL('./workers/sim.worker.ts', import.meta.url),
      { type: 'module' },
    )

    // 仿真快照只活在 ref 中：不进 React state，不触发重渲染。
    const latestSnapshot = new Float32Array(COUNT * 4)
    const onMessage = (e: MessageEvent<Float32Array>) => {
      latestSnapshot.set(e.data)
    }
    worker.onmessage = onMessage

    // tick 为单调递增的帧序号（仿真固定步长），不再使用 Date.now()。
    let tick = 0
    const timer = window.setInterval(() => {
      tick += 1
      worker.postMessage({ tick, count: COUNT })
    }, 16)

    // 尺寸：仅在 clientWidth/Height 实际变化时才重设位图。
    let cssWidth = 0
    let cssHeight = 0
    const syncSize = () => {
      const nextWidth = canvas.clientWidth
      const nextHeight = canvas.clientHeight
      if (nextWidth !== cssWidth || nextHeight !== cssHeight) {
        cssWidth = nextWidth
        cssHeight = nextHeight
        canvas.width = nextWidth
        canvas.height = nextHeight
      }
    }

    // FPS：基于真实 rAF 帧间隔的滑动均值，<=4Hz 直写 textContent。
    const frameIntervals = new Float32Array(FPS_WINDOW)
    let frameCursor = 0
    let frameSamples = 0
    let lastFrameTime = 0
    let lastHudTime = 0

    let rafId = 0
    const loop = (now: number) => {
      syncSize()
      ctx.clearRect(0, 0, cssWidth, cssHeight)

      if (lastFrameTime !== 0) {
        frameIntervals[frameCursor] = now - lastFrameTime
        frameCursor = (frameCursor + 1) % FPS_WINDOW
        if (frameSamples < FPS_WINDOW) frameSamples += 1
      }
      lastFrameTime = now

      const data = latestSnapshot
      for (let i = 0; i < COUNT; i++) {
        const x = data[i * 4]
        const y = data[i * 4 + 1]
        const grad = ctx.createRadialGradient(x, y, 0, x, y, 12)
        grad.addColorStop(0, `rgba(255,255,255,${OPACITY.toFixed(2)})`)
        grad.addColorStop(1, 'rgba(0,0,0,0)')
        ctx.save()
        ctx.shadowBlur = 18
        ctx.shadowColor = '#639'
        ctx.fillStyle = grad
        ctx.beginPath()
        ctx.arc(x, y, 6, 0, Math.PI * 2)
        ctx.fill()
        ctx.restore()
      }

      if (frameSamples > 0 && now - lastHudTime >= HUD_INTERVAL_MS) {
        let intervalSum = 0
        for (let i = 0; i < frameSamples; i++) intervalSum += frameIntervals[i]
        const avgInterval = intervalSum / frameSamples
        const fps = Math.round(1000 / Math.max(1, avgInterval))
        const hud = hudRef.current
        if (hud) {
          hud.textContent =
            `fps ${fps} / ${avgInterval.toFixed(1)}ms / particles ${COUNT * 4}`
        }
        lastHudTime = now
      }

      rafId = requestAnimationFrame(loop)
    }
    rafId = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(rafId)
      window.clearInterval(timer)
      worker.onmessage = null
      worker.terminate()
    }
  }, [])

  return (
    <div style={{ width: '100vw', height: '100vh', background: '#111' }}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%' }} />
      <div
        ref={hudRef}
        style={{ position: 'fixed', top: 8, left: 8, color: '#fff' }}
      >
        fps - / -ms / particles {COUNT * 4}
      </div>
    </div>
  )
}

export default App
