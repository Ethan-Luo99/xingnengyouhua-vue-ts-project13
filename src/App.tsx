import { useEffect, useRef } from 'react'
import './App.css'

const COUNT = 1200
const CORE_COLOR = 'rgba(255,255,255,0.6)'
const HUD_INTERVAL_MS = 250

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const hudRef = useRef<HTMLDivElement>(null)
  const latestRef = useRef<Float32Array | null>(null)

  useEffect(() => {
    const worker = new Worker(
      new URL('./workers/sim.worker.ts', import.meta.url),
      { type: 'module' },
    )
    worker.onmessage = (e: MessageEvent<Float32Array>) => {
      latestRef.current = e.data
    }
    const timer = setInterval(() => {
      worker.postMessage({ tick: Date.now(), count: COUNT })
    }, 16)
    return () => {
      clearInterval(timer)
      worker.onmessage = null
      worker.terminate()
    }
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    canvas.width = canvas.clientWidth
    canvas.height = canvas.clientHeight

    let rafId = 0
    let frames = 0
    let windowStart = -1
    let lastHud = 0
    let fps = 0

    const loop = (t: number) => {
      rafId = requestAnimationFrame(loop)

      if (windowStart < 0) {
        windowStart = t
        lastHud = t
      }
      frames++
      const elapsed = t - windowStart
      if (elapsed >= 500) {
        fps = ((frames - 1) * 1000) / elapsed
        frames = 1
        windowStart = t
      }
      if (t - lastHud >= HUD_INTERVAL_MS && hudRef.current) {
        lastHud = t
        hudRef.current.textContent = `fps ${Math.round(fps)} / ${fps > 0 ? (1000 / fps).toFixed(1) : '-'}ms / particles ${COUNT}`
      }

      const data = latestRef.current
      if (!data) return
      ctx.clearRect(0, 0, canvas.width, canvas.height)

      for (let i = 0; i < COUNT; i++) {
        const x = data[i * 4]
        const y = data[i * 4 + 1]
        const grad = ctx.createRadialGradient(x, y, 0, x, y, 12)
        grad.addColorStop(0, CORE_COLOR)
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
    }
    rafId = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(rafId)
  }, [])

  useEffect(() => {
    const onResize = () => {
      const c = canvasRef.current
      if (!c) return
      c.width = c.clientWidth
      c.height = c.clientHeight
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  return (
    <div style={{ width: '100vw', height: '100vh', background: '#111' }}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%' }} />
      <div ref={hudRef} style={{ position: 'fixed', top: 8, left: 8, color: '#fff' }}>
        fps -- / --ms / particles {COUNT}
      </div>
    </div>
  )
}

export default App
