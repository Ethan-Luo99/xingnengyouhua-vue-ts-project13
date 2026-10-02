import { useEffect, useRef } from 'react'
import './App.css'
import type { MainToWorker, WorkerToMain } from './workers/sim-core'

const COUNT = 1200
const HUD_INTERVAL_MS = 250
const MAX_DT_MS = 100
const MAX_DPR = 2
// sprite 位图 96px，按 48 CSS px 绘制（DPR 2 下仍清晰）；
// 视觉对应原实现：白色径向渐变核心 r=12 + shadowBlur=18 的 #639 辉光
const SPRITE_PX = 96
const DRAW_SIZE = 48
const DRAW_HALF = DRAW_SIZE / 2

function bakeSprite(): HTMLCanvasElement {
  const sprite = document.createElement('canvas')
  sprite.width = SPRITE_PX
  sprite.height = SPRITE_PX
  const s = sprite.getContext('2d')
  if (!s) return sprite
  const c = SPRITE_PX / 2
  const scale = SPRITE_PX / DRAW_SIZE

  const glow = s.createRadialGradient(c, c, 0, c, c, c)
  glow.addColorStop(0, 'rgba(102,51,153,0.55)')
  glow.addColorStop(0.45, 'rgba(102,51,153,0.22)')
  glow.addColorStop(1, 'rgba(102,51,153,0)')
  s.fillStyle = glow
  s.fillRect(0, 0, SPRITE_PX, SPRITE_PX)

  const coreRadius = 12 * scale
  const core = s.createRadialGradient(c, c, 0, c, c, coreRadius)
  core.addColorStop(0, 'rgba(255,255,255,0.6)')
  core.addColorStop(1, 'rgba(0,0,0,0)')
  s.fillStyle = core
  s.beginPath()
  s.arc(c, c, coreRadius, 0, Math.PI * 2)
  s.fill()
  return sprite
}

// MDN 式能力探测：浏览器只有实现了 module worker 才会读取 options.type
function detectModuleWorker(): boolean {
  let supported = false
  try {
    const tester = {
      get type() {
        supported = true
        return 'module'
      },
    }
    new Worker('blob://', tester as unknown as WorkerOptions).terminate()
  } catch {
    // 无效 URL 可能同步抛错，但只要 type getter 被读过即视为支持
  }
  return supported
}

function createSimWorker(): Worker {
  if (detectModuleWorker()) {
    try {
      return new Worker(new URL('./workers/sim.worker.ts', import.meta.url), {
        type: 'module',
      })
    } catch {
      // 构造期失败（如旧 Safari）落到 classic 入口
    }
  }
  return new Worker(new URL('./workers/sim.classic.worker.ts', import.meta.url))
}

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const hudRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const worker = createSimWorker()

    let latest: Float32Array<ArrayBuffer> | null = null
    let inFlight = false
    let rafId = 0
    let simTime = 0
    let lastT = -1
    let cssWidth = 0
    let cssHeight = 0
    let hidden = document.hidden
    let inViewport = true

    // 位图尺寸唯一写入源：仅此处允许改 canvas.width/height
    const applySize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR)
      cssWidth = canvas.clientWidth
      cssHeight = canvas.clientHeight
      const w = Math.max(1, Math.round(cssWidth * dpr))
      const h = Math.max(1, Math.round(cssHeight * dpr))
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    // 同步初始化，避免 ResizeObserver 首回调与首帧绘制的竞态
    applySize()
    const ro = new ResizeObserver(applySize)
    ro.observe(canvas)

    // 标签页隐藏或画布滚出视口时暂停仿真请求；恢复时重置时间基准，
    // 配合 MAX_DT_MS 钳制防止追帧跳变
    const onVisibility = () => {
      hidden = document.hidden
      if (!hidden) lastT = -1
    }
    document.addEventListener('visibilitychange', onVisibility)
    const io = new IntersectionObserver((entries) => {
      inViewport = entries[0]?.isIntersecting ?? true
      if (inViewport) lastT = -1
    })
    io.observe(canvas)

    const sprite = bakeSprite()

    const send = (msg: MainToWorker, transfer?: Transferable[]) => {
      worker.postMessage(msg, transfer ? { transfer } : undefined)
    }

    send({ type: 'init', count: COUNT })
    worker.onmessage = (e: MessageEvent<WorkerToMain>) => {
      const msg = e.data
      if (msg.type !== 'frame') return
      inFlight = false
      // 旧快照所有权归还 Worker 复用，稳态零分配
      if (latest) send({ type: 'recycle', buffer: latest.buffer }, [latest.buffer])
      latest = msg.view
    }

    let frames = 0
    let windowStart = -1
    let lastHud = 0
    let fps = 0

    const loop = (t: number) => {
      rafId = requestAnimationFrame(loop)

      const dt = lastT < 0 ? 0 : Math.min(t - lastT, MAX_DT_MS)
      lastT = t

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

      // 拉模式背压：上一拍未回来就不发新请求，主线程卡顿时仿真自动降速；
      // 隐藏或滚出视口时暂停请求，Worker 自然空转
      if (!inFlight && !hidden && inViewport) {
        inFlight = true
        simTime += dt
        send({ type: 'tick', tick: simTime })
      }

      if (!latest) return
      ctx.clearRect(0, 0, cssWidth, cssHeight)
      ctx.globalCompositeOperation = 'lighter'
      for (let i = 0; i < COUNT; i++) {
        ctx.drawImage(
          sprite,
          latest[i * 4] - DRAW_HALF,
          latest[i * 4 + 1] - DRAW_HALF,
          DRAW_SIZE,
          DRAW_SIZE,
        )
      }
      ctx.globalCompositeOperation = 'source-over'
    }
    rafId = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(rafId)
      ro.disconnect()
      io.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      worker.onmessage = null
      worker.terminate()
    }
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
