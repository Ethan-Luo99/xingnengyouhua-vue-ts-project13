import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import './App.css'
import { createSimWorker } from './workers/createSimWorker'
import {
  DEFAULT_PARTICLE_COUNT,
  DEFAULT_SPEED,
  FORCE_RADIUS,
  FORCE_STRENGTH,
  PARTICLE_TIERS,
  SPEED_PRESETS,
  type SimMainMessage,
  type SimSeekRequest,
  type SimResizeRequest,
  type SimStateMessage,
  type SimTickRequest,
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
  sctx.fillStyle = grad
  sctx.beginPath()
  sctx.arc(SPRITE_HALF, SPRITE_HALF, PARTICLE_RADIUS, 0, Math.PI * 2)
  sctx.fill()
  return sprite
}

type SimApi = {
  setManualPaused(paused: boolean): void
  requestSingleStep(): void
  setSpeed(speed: number): void
  requestSeek(seq: number): void
  requestLive(): void
  requestResize(count: number): void
}

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const hudRef = useRef<HTMLDivElement>(null)
  const sliderRef = useRef<HTMLInputElement>(null)
  const sliderDraggingRef = useRef(false)
  const syncSliderRef = useRef<(() => void) | null>(null)
  const simApiRef = useRef<SimApi | null>(null)
  const [manualPaused, setManualPaused] = useState(false)
  const [speed, setSpeed] = useState<number>(DEFAULT_SPEED)
  const [tier, setTier] = useState<number>(DEFAULT_PARTICLE_COUNT)
  const [replay, setReplay] = useState(false)

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
    // display 为当前主线程持有的壳；tick/seek/resize 三类请求统一排队，帧内最多发一个。
    let display: Float32Array<ArrayBuffer> | null = null
    let inFlight = false
    let seq = 0
    let particleCount = DEFAULT_PARTICLE_COUNT
    let modeNow: 'live' | 'replay' = 'live'
    let oldestSeqNow = 0
    let latestSeqNow = 0
    let resizing = false

    // 力命令结构常驻，随 tick 复用下发：仅标量覆写，稳态零新增对象。
    const forceCommand = {
      active: 0,
      x: 0,
      y: 0,
      radius: FORCE_RADIUS,
      strength: FORCE_STRENGTH,
    }
    const tickMessage: SimTickRequest = {
      type: 'tick',
      seq: 0,
      steps: 1,
      force: forceCommand,
    }
    // seek/resize 消息对象同样常驻复用，不随交互新建。
    const seekMessage: SimSeekRequest = {
      type: 'seek',
      seq: 0,
      mode: 'replay',
    }
    const resizeMessage: SimResizeRequest = { type: 'resize', count: 0 }
    const transferList: ArrayBuffer[] = []
    let pendingSeek = false
    let pendingResize = -1

    // --- 暂停（生命周期 + 手动）/ 单步 / 倍速 ---
    let lifePaused = false
    let manualPausedNow = false
    let speedNow = DEFAULT_SPEED
    let speedAccumulator = 0
    let pendingSingleStep = 0
    const isPaused = () => lifePaused || manualPausedNow

    // 把当前壳（若有）挂到请求上并随 buffer transfer；统一三类请求的壳回收。
    const sendWithShell = (message: SimMainMessage) => {
      const consumed = display
      display = null
      inFlight = true
      if (consumed) {
        ;(message as { recycle?: Float32Array<ArrayBuffer> }).recycle =
          consumed
        transferList[0] = consumed.buffer
        worker!.postMessage(message, transferList)
      } else {
        ;(message as { recycle?: Float32Array<ArrayBuffer> }).recycle =
          undefined
        worker!.postMessage(message)
      }
    }

    const requestTick = (steps: number, allowWhilePaused = false) => {
      if (inFlight || !worker) return
      // 常规播放受暂停门控；手动「单步」是显式指令，允许在手动暂停时推进一步。
      if (isPaused() && !allowWhilePaused) return
      seq += steps
      tickMessage.seq = seq
      tickMessage.steps = steps
      sendWithShell(tickMessage)
    }

    // --- 生命周期：页面隐藏 / 画布滚出视口 -> 暂停仿真请求 ---
    let documentVisible = !document.hidden
    let canvasIntersecting = true
    lifePaused = !documentVisible || !canvasIntersecting

    simApiRef.current = {
      setManualPaused(paused: boolean) {
        manualPausedNow = paused
        if (!paused) speedAccumulator = 0
      },
      requestSingleStep() {
        if (!manualPausedNow || lifePaused) return
        pendingSingleStep = 1
      },
      setSpeed(next: number) {
        speedNow = next
        speedAccumulator = 0
      },
      requestSeek(target: number) {
        // 仅档位切换进行中忽略，避免跨尺寸壳混用；
        // 若此刻有在途 tick 不丢弃：先武装 pending，主循环在壳空闲的下一帧发送。
        if (!worker || resizing) return
        seekMessage.seq = target
        seekMessage.mode = 'replay'
        pendingSeek = true
      },
      requestLive() {
        if (!worker || resizing) return
        seekMessage.seq = latestSeqNow
        seekMessage.mode = 'live'
        pendingSeek = true
      },
      requestResize(nextCount: number) {
        if (!worker) return
        pendingResize = nextCount
      },
    }

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
        lifePaused = !documentVisible || !canvasIntersecting
      },
      { threshold: 0 },
    )
    intersectionObserver.observe(canvas)

    const onVisibilityChange = () => {
      documentVisible = !document.hidden
      lifePaused = !documentVisible || !canvasIntersecting
      if (documentVisible) lastFrameTime = 0
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    // --- 交互斥力：按下拖拽期间把指针坐标写进复用的力命令（CSS 像素）---
    let pointerDown = false
    const updateForceFromEvent = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect()
      forceCommand.x = clientX - rect.left
      forceCommand.y = clientY - rect.top
    }
    const onPointerDown = (e: PointerEvent) => {
      pointerDown = true
      forceCommand.active = 1
      updateForceFromEvent(e.clientX, e.clientY)
      try {
        canvas.setPointerCapture(e.pointerId)
      } catch {
        // 不支持捕获时退化为 window pointerup，行为仍正确。
      }
    }
    const onPointerMove = (e: PointerEvent) => {
      if (!pointerDown) return
      updateForceFromEvent(e.clientX, e.clientY)
    }
    const onPointerUp = (e: PointerEvent) => {
      pointerDown = false
      forceCommand.active = 0
      try {
        canvas.releasePointerCapture(e.pointerId)
      } catch {
        // 忽略未持有捕获的释放。
      }
    }
    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('pointercancel', onPointerUp)

    // FPS：真实 rAF 帧间隔的滑动均值，<=4Hz 直写 textContent。
    const frameIntervals = new Float32Array(FPS_WINDOW)
    let frameCursor = 0
    let frameSamples = 0
    let lastFrameTime = 0
    let lastHudTime = 0

    const syncSlider = () => {
      const slider = sliderRef.current
      if (!slider || sliderDraggingRef.current) return
      slider.min = String(oldestSeqNow)
      slider.max = String(latestSeqNow)
      const shown = Math.max(oldestSeqNow, Math.min(latestSeqNow, seq))
      slider.value = String(shown)
    }
    syncSliderRef.current = syncSlider

    const loop = (now: number) => {
      if (disposed) return

      if (lastFrameTime !== 0) {
        const delta = now - lastFrameTime
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
        for (let i = 0; i < particleCount; i++) {
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

      // 请求优先级：resize > seek > tick；帧内最多一个请求，在途恒 <=1。
      if (worker && !inFlight) {
        if (pendingResize >= 0 && !resizing) {
          resizing = true
          resizeMessage.count = pendingResize
          pendingResize = -1
          sendWithShell(resizeMessage)
        } else if (pendingSeek) {
          pendingSeek = false
          sendWithShell(seekMessage)
        } else {
          // 倍速 = 每帧多固定步长（4x）/ 累加器 0.25x；单步仅手动暂停时插队。
          let steps = 0
          if (pendingSingleStep !== 0) {
            steps = 1
            pendingSingleStep = 0
            requestTick(steps, true)
          } else if (!isPaused()) {
            if (speedNow >= 1) {
              steps = speedNow
            } else {
              speedAccumulator += speedNow
              if (speedAccumulator >= 1) {
                steps = 1
                speedAccumulator -= 1
              }
            }
            if (steps > 0) requestTick(steps)
          }
        }
      }

      if (frameSamples > 0 && now - lastHudTime >= HUD_INTERVAL_MS) {
        let intervalSum = 0
        for (let i = 0; i < frameSamples; i++) intervalSum += frameIntervals[i]
        const avgInterval = intervalSum / frameSamples
        const fps = Math.round(1000 / Math.max(1, avgInterval))
        const hud = hudRef.current
        if (hud) {
          hud.textContent =
            `fps ${fps} / ${avgInterval.toFixed(1)}ms / particles ${particleCount}` +
            ` / seq ${seq} / mode ${modeNow} / speed ${speedNow}x` +
            ` / ${isPaused() ? 'paused' : 'running'}`
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
      worker.onmessage = (e: MessageEvent<SimStateMessage>) => {
        const msg = e.data
        if (msg.type !== 'state') return
        if (resizing) {
          // 档位切换响应：采用新壳（旧壳已在请求时随 buffer 转移给 worker 回收）。
          particleCount = msg.count
          resizing = false
        }
        display = msg.particles
        seq = msg.seq
        modeNow = msg.mode
        oldestSeqNow = msg.oldestSeq
        latestSeqNow = msg.latestSeq
        inFlight = false
        const isReplay = msg.mode === 'replay'
        setReplay((prev) => (prev === isReplay ? prev : isReplay))
        syncSlider()
      }
    })

    return () => {
      disposed = true
      cancelAnimationFrame(rafId)
      resizeObserver.disconnect()
      intersectionObserver.disconnect()
      document.removeEventListener('visibilitychange', onVisibilityChange)
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointercancel', onPointerUp)
      simApiRef.current = null
      syncSliderRef.current = null
      if (worker) {
        worker.onmessage = null
        worker.terminate()
        worker = null
      }
      display = null
    }
  }, [])

  const togglePause = () => {
    const next = !manualPaused
    setManualPaused(next)
    simApiRef.current?.setManualPaused(next)
  }
  const singleStep = () => simApiRef.current?.requestSingleStep()
  const changeSpeed = (next: number) => {
    setSpeed(next)
    simApiRef.current?.setSpeed(next)
  }
  const changeTier = (next: number) => {
    if (next === tier) return
    setTier(next)
    simApiRef.current?.requestResize(next)
  }
  const onSliderInput = (e: ChangeEvent<HTMLInputElement>) => {
    simApiRef.current?.requestSeek(Number(e.target.value))
  }
  const goLive = () => simApiRef.current?.requestLive()

  return (
    <div style={{ width: '100vw', height: '100vh', background: '#111' }}>
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%', touchAction: 'none' }}
      />
      <div
        ref={hudRef}
        style={{ position: 'fixed', top: 8, left: 8, color: '#fff' }}
      >
        fps - / -ms / particles {DEFAULT_PARTICLE_COUNT} / seq 0 / mode live
        / speed {DEFAULT_SPEED}x / running
      </div>
      <div
        style={{
          position: 'fixed',
          top: 8,
          right: 8,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          alignItems: 'flex-end',
        }}
      >
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={togglePause}>
            {manualPaused ? '▶ 继续' : '⏸ 暂停'}
          </button>
          <button type="button" onClick={singleStep} disabled={!manualPaused}>
            ⏭ 单步
          </button>
          {SPEED_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => changeSpeed(preset)}
              style={{
                fontWeight: speed === preset ? 700 : 400,
                outline: speed === preset ? '2px solid #c084fc' : 'none',
              }}
            >
              {preset}x
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {PARTICLE_TIERS.map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => changeTier(preset)}
              style={{
                fontWeight: tier === preset ? 700 : 400,
                outline: tier === preset ? '2px solid #c084fc' : 'none',
              }}
            >
              {preset}
            </button>
          ))}
        </div>
        <div
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            color: '#fff',
            background: 'rgba(0,0,0,0.35)',
            padding: '4px 8px',
            borderRadius: 6,
          }}
        >
          <span>{replay ? 'replay' : 'live'}</span>
          <input
            ref={sliderRef}
            type="range"
            min={0}
            max={0}
            defaultValue={0}
            onPointerDown={() => {
              sliderDraggingRef.current = true
            }}
            onPointerUp={() => {
              sliderDraggingRef.current = false
              syncSliderRef.current?.()
            }}
            onChange={onSliderInput}
          />
          <button type="button" onClick={goLive} disabled={!replay}>
            回到 live
          </button>
        </div>
      </div>
    </div>
  )
}

export default App
