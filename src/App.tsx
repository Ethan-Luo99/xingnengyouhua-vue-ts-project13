import { useEffect, useRef } from 'react'
import './App.css'
import { createSimWorker } from './workers/createSimWorker'
import {
  BUFFER_FLOATS,
  PARTICLE_COUNT,
  type SimTickRequest,
  type SimWorkerMessage,
} from './workers/protocol'

const OPACITY = 0.6
const HUD_INTERVAL_MS = 250
const FPS_WINDOW = 60
// 恢复后首个帧间隔若超过该值则视为「后台/暂停间隙」，不计入 FPS，也不触发追帧。
const MAX_FRAME_DELTA_MS = 100

// sprite 以 2 倍尺寸烘焙，DPR<=2 的位图上 drawImage 不会发虚。
const SPRITE_SIZE = 64
const SPRITE_PIXELS = 128
const SPRITE_HALF = SPRITE_SIZE / 2
const PARTICLE_RADIUS = 6
const SHADOW_BLUR = 18
const SHADOW_COLOR = '#639'

function bakeSprite(): HTMLCanvasElement {
  const sprite = document.createElement('canvas')
  sprite.width = SPRITE_PIXELS
  sprite.height = SPRITE_PIXELS
  const sctx = sprite.getContext('2d')
  if (!sctx) return sprite
  sctx.scale(2, 2)
  // 与原逐粒子绘制完全相同的一次离屏绘制：径向渐变 + shadowBlur 辉光烘焙进 alpha。
  const grad = sctx.createRadialGradient(
    SPRITE_HALF,
    SPRITE_HALF,
    0,
    SPRITE_HALF,
    SPRITE_HALF,
    12,
  )
  grad.addColorStop(0, `rgba(255,255,255,${OPACITY})`)
  grad.addColorStop(1, 'rgba(0,0,0,0)')
  sctx.shadowBlur = SHADOW_BLUR
  sctx.shadowColor = SHADOW_COLOR
  sctx.fillStyle =  grad
  sctx.beginPath()
  sctx.arc(SPRITE_HALF, SPRITE_HALF, PARTICLE_RADIUS, 0, Math.PI * 2)
  sctx.fill()
  return sprite
}

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const hudRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const sprite = bakeSprite()
    let disposed = false
    let worker: Worker | null = null
    let rafId = 0

    // --- Transferable 单壳乒乓：拉模式，在途请求恒 <=1 ---
    let display: Float32Array<ArrayBuffer> | null = null
    let inFlight = false
    let seq = 0
    const tickMessage: SimTickRequest = { type: 'tick', seq: 0 }
    const transferList: ArrayBuffer[] = []

    const requestTick = () => {
      if (inFlight || paused || !worker) return
      const consumed = display
      display = null
      inFlight = true
      seq += 1
      tickMessage.seq = seq
      if (consumed) {
        // 传输壳视图随其 buffer 一起 transfer：worker 收到即可直接写，无需重新包视图。
        tickMessage.recycle = consumed
        transferList[0] = consumed.buffer
        worker.postMessage(tickMessage, transferList)
      } else {
        tickMessage.recycle = undefined
        worker.postMessage(tickMessage)
      }
    }

    // --- 生命周期：页面隐藏 / 画布滚出视口 -> 暂停仿真请求 ---
    let documentVisible = !document.hidden
    let canvasIntersecting = true
    let paused = !documentVisible || !canvasIntersecting

    // --- ResizeObserver 是 canvas 位图尺寸的唯一写入源（DPR 钳制 + setTransform）---
    let cssWidth = 0
    let cssHeight = 0
    let dpr = 0
    const applyCanvasSize = () => {
      const nextDpr = Math.min(window.devicePixelRatio || 1, 2)
      const nextCssWidth = canvas.clientWidth
      const nextCssHeight = canvas.clientHeight
      const nextWidth = Math.max(1, Math.round(nextCssWidth * nextDpr))
      const nextHeight = Math.max(1, Math.round(nextCssHeight * nextDpr))
      if (
        canvas.width !== nextWidth ||
        canvas.height !== nextHeight ||
        nextDpr !== dpr
      ) {
        dpr = nextDpr
        cssWidth = nextCssWidth
        cssHeight = nextCssHeight
        canvas.width = nextWidth
        canvas.height = nextHeight
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      }
    }
    applyCanvasSize()
    const resizeObserver = new ResizeObserver(applyCanvasSize)
    resizeObserver.observe(canvas)

    const intersectionObserver = new IntersectionObserver(
      (entries) => {
        canvasIntersecting = entries[0]?.isIntersecting ?? true
        paused = !documentVisible || !canvasIntersecting
      },
      { threshold: 0 },
    )
    intersectionObserver.observe(canvas)

    const onVisibilityChange = () => {
      documentVisible = !document.hidden
      paused = !documentVisible || !canvasIntersecting
      if (documentVisible) lastFrameTime = 0 // 恢复后重置基准，防止 dt 跳变
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    // FPS：真实 rAF 帧间隔的滑动均值，<=4Hz 直写 textContent。
    const frameIntervals = new Float32Array(FPS_WINDOW)
    let frameCursor = 0
    let frameSamples = 0
    let lastFrameTime = 0
    let lastHudTime = 0

    const loop = (now: number) => {
      if (disposed) return

      if (lastFrameTime !== 0) {
        const delta = now - lastFrameTime
        // dt 钳制：仅统计正常帧间隔；后台恢复的巨大间隔被丢弃，不污染 FPS、不触发追帧。
        if (delta <= MAX_FRAME_DELTA_MS) {
          frameIntervals[frameCursor] = delta
          frameCursor = (frameCursor + 1) % FPS_WINDOW
          if (frameSamples < FPS_WINDOW) frameSamples += 1
        } else {
          frameSamples = 0
        }
      }
      lastFrameTime = now

      ctx.clearRect(0, 0, cssWidth, cssHeight)
      if (display) {
        for (let i = 0; i < PARTICLE_COUNT; i++) {
          const x = display[i * 4]
          const y = display[i * 4 + 1]
          ctx.drawImage(
            sprite,
            x - SPRITE_HALF,
            y - SPRITE_HALF,
            SPRITE_SIZE,
            SPRITE_SIZE,
          )
        }
      }

      // 暂停时不发起仿真请求：在途数量自然归零，无消息堆积；恢复时按帧重新拉取（无追帧）。
      requestTick()

      if (frameSamples > 0 && now - lastHudTime >= HUD_INTERVAL_MS) {
        let intervalSum = 0
        for (let i = 0; i < frameSamples; i++) intervalSum += frameIntervals[i]
        const avgInterval = intervalSum / frameSamples
        const fps = Math.round(1000 / Math.max(1, avgInterval))
        const hud = hudRef.current
        if (hud) {
          hud.textContent =
            `fps ${fps} / ${avgInterval.toFixed(1)}ms / particles ${BUFFER_FLOATS}`
        }
        lastHudTime = now
      }

      rafId = requestAnimationFrame(loop)
    }
    rafId = requestAnimationFrame(loop)

    createSimWorker().then(({ worker: created }) => {
      if (disposed) {
        created.terminate()
        return
      }
      worker = created
      worker.onmessage = (e: MessageEvent<SimWorkerMessage>) => {
        const msg = e.data
        if (msg.type !== 'state') return
        display = msg.particles
        inFlight = false
      }
      // 首拍由 rAF 节拍在创建完成后发出；若当前已暂停则等恢复。
      if (!paused) requestTick()
    })

    return () => {
      disposed = true
      cancelAnimationFrame(rafId)
      resizeObserver.disconnect()
      intersectionObserver.disconnect()
      document.removeEventListener('visibilitychange', onVisibilityChange)
      if (worker) {
        worker.onmessage = null
        worker.terminate()
        worker = null
      }
      display = null
    }
  }, [])

  return (
    <div style={{ width: '100vw', height: '100vh', background: '#111' }}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%' }} />
      <div
        ref={hudRef}
        style={{ position: 'fixed', top: 8, left: 8, color: '#fff' }}
      >
        fps - / -ms / particles {BUFFER_FLOATS}
      </div>
    </div>
  )
}

export default App

