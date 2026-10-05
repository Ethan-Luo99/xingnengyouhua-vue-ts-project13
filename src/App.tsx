import { useEffect, useRef } from 'react'
import './App.css'
import {
  BUFFER_FLOATS,
  PARTICLE_COUNT,
  type SimStateMessage,
  type SimTickRequest,
} from './workers/protocol'

const OPACITY = 0.6
const HUD_INTERVAL_MS = 250
const FPS_WINDOW = 60

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
  sctx.fillStyle = grad
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

    const worker = new Worker(
      new URL('./workers/sim.worker.ts', import.meta.url),
      { type: 'module' },
    )

    const sprite = bakeSprite()

    // --- Transferable 双缓冲乒乓：拉模式，在途请求恒 <=1 ---
    // display 为本帧用于绘制的缓冲；它在本帧绘制结束、发起下一 tick 时随消息归还。
    let display: Float32Array<ArrayBuffer> | null = null
    let inFlight = false
    let seq = 0
    const tickMessage: SimTickRequest = { type: 'tick', seq: 0 }
    const transferList: ArrayBuffer[] = []

    worker.onmessage = (e: MessageEvent<SimStateMessage>) => {
      const msg = e.data
      if (msg.type !== 'state') return
      display = msg.particles
      inFlight = false
    }

    // 在本帧绘制结束后调用：此时 display 缓冲的读取已全部完成，可安全归还所有权。
    const requestTick = () => {
      if (inFlight) return
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

    // --- ResizeObserver 是 canvas 位图尺寸的唯一写入源（DPR 钳制 + setTransform）---
    // 帧循环只读 cssWidth/cssHeight，绝不写 canvas.width/height。
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
    // 挂载期同步初始化一次，消除「RO 首次回调晚于首帧」的竞态；此后仅由 RO 驱动。
    applyCanvasSize()
    const resizeObserver = new ResizeObserver(applyCanvasSize)
    resizeObserver.observe(canvas)

    // FPS：真实 rAF 帧间隔的滑动均值，<=4Hz 直写 textContent。
    const frameIntervals = new Float32Array(FPS_WINDOW)
    let frameCursor = 0
    let frameSamples = 0
    let lastFrameTime = 0
    let lastHudTime = 0

    let rafId = 0
    const loop = (now: number) => {
      if (lastFrameTime !== 0) {
        frameIntervals[frameCursor] = now - lastFrameTime
        frameCursor = (frameCursor + 1) % FPS_WINDOW
        if (frameSamples < FPS_WINDOW) frameSamples += 1
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

      // 绘制结束后才发起下一 tick；recycle 缓冲的读取已结束，可安全转移。
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
    requestTick()
    rafId = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(rafId)
      resizeObserver.disconnect()
      worker.onmessage = null
      worker.terminate()
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
