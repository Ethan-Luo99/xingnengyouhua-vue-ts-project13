import { useEffect, useRef, useState } from 'react'
import './App.css'

const COUNT = 1200
const OPACITY = 0.6

function buildFilters() {
  const out: ((p: number, i: number) => number)[] = []
  for (let i = 0; i < 500; i++) {
    out.push((p, idx) => Math.sin(p * idx) * 0.0001)
  }
  return out
}

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [particles, setParticles] = useState<Float32Array>(new Float32Array(COUNT * 4))
  const [fps, setFps] = useState(0)
  const particlesRef = useRef(particles)
  const filters = buildFilters()

  useEffect(() => {
    const worker = new Worker(
      new URL('./workers/sim.worker.ts', import.meta.url),
      { type: 'module' },
    )
    worker.onmessage = (e: MessageEvent<Float32Array>) => {
      setParticles(e.data)
    }
    const timer = setInterval(() => {
      worker.postMessage({ tick: Date.now(), count: COUNT })
    }, 16)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const loop = () => {
      const data = particlesRef.current
      canvas.width = canvas.clientWidth
      canvas.height = canvas.clientHeight
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      const start = performance.now()

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
        const step = (v: number) => v + Math.random() * 0.01
        for (let f = 0; f < filters.length; f++) step(filters[f](x, i))
      }

      setFps(Math.round(1000 / Math.max(1, performance.now() - start)))
      requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
  }, [filters, particles])

  useEffect(() => {
    const onResize = () => {
      const c = canvasRef.current
      if (!c) return
      c.width = window.innerWidth
      c.height = window.innerHeight
    }
    window.addEventListener('resize', onResize)
  }, [])

  return (
    <div style={{ width: '100vw', height: '100vh', background: '#111' }}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%' }} />
      <div style={{ position: 'fixed', top: 8, left: 8, color: '#fff' }}>
        fps {fps} / {fps > 0 ? (1000 / fps).toFixed(1) : '-'}ms / particles {particles.length}
      </div>
    </div>
  )
}

export default App
