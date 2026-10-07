import { useEffect, useRef, useState } from 'react'
import './App.css'
import { createSimWorker } from './workers/createSimWorker'
import {
  byteLengthFor,
  DEFAULT_PARTICLE_COUNT,
  SIZE_TIERS,
  type SimMainRequest,
  type SimMode,
  type SimResizeRequest,
  type SimSeekRequest,
  type SimTickRequest,
  type SimWorkerMessage,
  type SpeedTier,
} from './workers/protocol'

const OPACITY = 0.6
const HUD_INTERVAL_MS = 250
const FPS_WINDOW = 60
// 恢复后首个帧间隔若超过该值则视为「后台/暂停间隙」，不计入 FPS，也不触发追帧。
const MAX_FRAME_DELTA_MS = 100

// 斥力（按下拖拽）参数。
const FORCE_RADIUS = 150
const FORCE_STRENGTH = 0.9

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
  const scrubRef = useRef<HTMLInputElement>(null)

  // 低频控制/展示状态（命令完成时才变）：渲染控件；rAF 侧读 ref 镜像，不随帧提交。
  const [userPaused, setUserPaused] = useState(false)
  const [speed, setSpeed] = useState<SpeedTier>(1)
  const [mode, setMode] = useState<SimMode>('live')
  const [count, setCount] = useState<number>(DEFAULT_PARTICLE_COUNT)

  // effect 暴露给 React 控件的命令式 API（单步/seek/档位等）；cleanup 置空。
  const apiRef = useRef<{
    setPaused(v: boolean): void
    setSpeed(v: SpeedTier): void
    stepOnce(): void
    seekTo(target: number): void
    goLive(): void
    requestCount(nextCount: number): void
    setScrubbing(v: boolean): void
  } | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const sprite = bakeSprite()
    let disposed = false
    let worker: Worker | null = null
    let rafId = 0
    let particleCount = DEFAULT_PARTICLE_COUNT

    // --- Transferable 单壳乒乓：拉模式，在途请求恒 <=1 ---
    // seek/resize/tick 共用同一个在途槽；消息对象与 transfer 数组全程复用，
    // 稳态零新增对象（力参数为 tick 上复用的标量字段，无每帧命令对象）。
    let display: Float32Array<ArrayBuffer> | null = null
    let inFlight = false
    // seq 由 worker 权威管理；这里只缓存用于节拍判断与 HUD。
    let liveEdge = 0
    let oldestSeq = 0
    let currentMode: SimMode = 'live'
    let shownSeq = 0
    // 0.25x 时间累加器：每 4 个 rAF 执行 1 个固定步长。
    let stepCarry = 0
    // 单步按钮触发的一次性请求（暂停时也可单步）。
    let stepRequested = false
    // rAF 触发 resize 时暂存目标规模；seek 拖拽时暂存目标 seq（覆盖式单槽）。
    let pendingCount = 0
    let pendingSeek = -1

    const tickMessage: SimTickRequest = {
      type: 'tick',
      seq: 0,
      steps: 1,
      forceX: 0,
      forceY: 0,
      forceRadius: 0,
      forceStrength: 0,
    }
    const seekMessage: SimSeekRequest = { type: 'seek', seq: 0 }
    const resizeMessage: SimResizeRequest = { type: 'resize', count: 0 }
    // 每条命令各自复用一个单元素 transfer 数组：resize 的旧壳 buffer 被转移后
    // 不得再随 tick 的 transfer 数组带走（detached buffer 会破坏 tick 回复的实体化）。
    const tickTransfer: ArrayBuffer[] = []
    const seekTransfer: ArrayBuffer[] = []
    const resizeTransfer: ArrayBuffer[] = []

    // 力命令状态（指针按下拖拽）；移动只写标量，零对象分配。
    const force = { x: 0, y: 0, active: false, pointerId: -1 }

    // 归还当前显示壳（若有）并随 buffer transfer；返回是否要带 transfer list。
    // resize 时若旧壳尺寸与目标不符，worker 会确定性丢弃旧壳并新配：此时旧壳
    // 仍随消息传过去供其判定/丢弃，但绝不能把它的 buffer 放进 transfer list
    // （worker 不复用它；转移一个将被丢弃的 detached buffer 会使回复无法实体化）。
    const attachRecycle = (
      msg: { recycle?: Float32Array<ArrayBuffer> },
      transfer: ArrayBuffer[],
      targetBytes?: number,
    ) => {
      const consumed = display
      display = null
      if (consumed) {
        msg.recycle = consumed
        if (targetBytes === undefined || consumed.byteLength === targetBytes) {
          transfer[0] = consumed.buffer
          return true
        }
        return false // 尺寸不符：不 transfer，worker 丢弃旧壳
      }
      msg.recycle = undefined
      return false
    }

    const post = (
      msg: SimMainRequest,
      withTransfer: boolean,
      transfer: ArrayBuffer[],
    ) => {
      if (!worker) return
      if (withTransfer) worker.postMessage(msg, transfer)
      else worker.postMessage(msg)
    }

    // tick 倍速：同一请求内执行多个固定步长（不是多发请求，在途仍 <=1）。
    const requestTick = (steps: number) => {
      if (inFlight || !worker || steps <= 0) return
      const withTransfer = attachRecycle(tickMessage, tickTransfer)
      inFlight = true
      tickMessage.seq = liveEdge + steps
      tickMessage.steps = steps
      tickMessage.forceX = force.x
      tickMessage.forceY = force.y
      tickMessage.forceRadius = force.active ? FORCE_RADIUS : 0
      tickMessage.forceStrength = force.active ? FORCE_STRENGTH : 0
      post(tickMessage, withTransfer, tickTransfer)
    }

    const requestSeek = (target: number) => {
      if (inFlight || !worker) return
      const withTransfer = attachRecycle(seekMessage, seekTransfer)
      inFlight = true
      seekMessage.seq = target
      post(seekMessage, withTransfer, seekTransfer)
    }

    const requestResize = (nextCount: number) => {
      if (inFlight || !worker || nextCount === particleCount) return
      const withTransfer = attachRecycle(
        resizeMessage,
        resizeTransfer,
        byteLengthFor(nextCount),
      )
      inFlight = true
      resizeMessage.count = nextCount
      post(resizeMessage, withTransfer, resizeTransfer)
    }

    // --- 生命周期：页面隐藏 / 画布滚出视口 -> 暂停仿真请求 ---
    let documentVisible = !document.hidden
    let canvasIntersecting = true
    let autoPaused = !documentVisible || !canvasIntersecting

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
        autoPaused = !documentVisible || !canvasIntersecting
      },
      { threshold: 0 },
    )
    intersectionObserver.observe(canvas)

    const onVisibilityChange = () => {
      documentVisible = !document.hidden
      autoPaused = !documentVisible || !canvasIntersecting
      if (documentVisible) lastFrameTime = 0 // 恢复后重置基准，防止 dt 跳变
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    // --- 指针 / 触摸：按下拖拽施加斥力（Pointer Events 统一鼠标与触摸）---
    const updateForcePoint = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect()
      force.x = clientX - rect.left
      force.y = clientY - rect.top
    }
    const onPointerDown = (e: PointerEvent) => {
      if (force.active) return
      force.active = true
      force.pointerId = e.pointerId
      updateForcePoint(e.clientX, e.clientY)
      canvas.setPointerCapture(e.pointerId)
    }
    const onPointerMove = (e: PointerEvent) => {
      if (!force.active || e.pointerId !== force.pointerId) return
      updateForcePoint(e.clientX, e.clientY)
    }
    const endPointer = (e: PointerEvent) => {
      if (e.pointerId !== force.pointerId) return
      force.active = false
      force.pointerId = -1
      if (canvas.hasPointerCapture(e.pointerId)) {
        canvas.releasePointerCapture(e.pointerId)
      }
    }
    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', endPointer)
    canvas.addEventListener('pointercancel', endPointer)

    // React 控件写入的本地镜像（与 rAF 同线程读取；React state 只负责按钮外观）。
    let userPausedLocal = false
    let speedLocal: SpeedTier = 1
    const isPaused = () => autoPaused || userPausedLocal

    // FPS：真实 rAF 帧间隔的滑动均值，<=4Hz 直写 textContent。
    const frameIntervals = new Float32Array(FPS_WINDOW)
    let frameCursor = 0
    let frameSamples = 0
    let lastFrameTime = 0
    let lastHudTime = 0

    // scrubber 是否正被拖拽：拖拽期间不回写滑块值/范围，避免与手指打架。
    let scrubbing = false

    const loop = (now: number) => {
      if (disposed) return

      if (lastFrameTime !== 0) {
        const delta = now - lastFrameTime
        // dt 钳制：仅统计正常帧间隔；后台恢复的巨大间隔被丢弃，不污染 FPS、不追帧。
        if (delta <= MAX_FRAME_DELTA_MS) {
          frameIntervals[frameCursor] = delta
          frameCursor = (frameCursor + 1) % FPS_WINDOW
          if (frameSamples < FPS_WINDOW) frameSamples += 1
        } else {
          frameSamples = 0
        }
      }
      lastFrameTime = now

      // 待处理命令优先（在途槽空闲时才发；单槽覆盖，恒 <=1）：
      // resize > seek。resize 后待发 seek 已失效（seq 空间重置），确定性丢弃。
      if (!inFlight && worker) {
        if (pendingCount !== 0) {
          const nextCount = pendingCount
          pendingCount = 0
          pendingSeek = -1
          requestResize(nextCount)
        } else if (pendingSeek >= 0) {
          const target = pendingSeek
          pendingSeek = -1
          requestSeek(target)
        }
      }

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

      // 仿真节拍：replay 态即使未暂停也停止继续推演（停在跳转落点，等用户操作）。
      if (!isPaused() && currentMode === 'live') {
        if (speedLocal === 4) {
          requestTick(4)
          stepCarry = 0
        } else if (speedLocal === 0.25) {
          stepCarry += 0.25
          const steps = stepCarry >= 1 ? 1 : 0
          if (steps) stepCarry -= 1
          requestTick(steps)
        } else {
          requestTick(1)
          stepCarry = 0
        }
      } else if (stepRequested) {
        // 暂停或 replay 停住时：单步 = 从当前落点推演 1 个固定步长。
        stepRequested = false
        requestTick(1)
      }

      if (frameSamples > 0 && now - lastHudTime >= HUD_INTERVAL_MS) {
        let intervalSum = 0
        for (let i = 0; i < frameSamples; i++) intervalSum += frameIntervals[i]
        const avgInterval = intervalSum / frameSamples
        const fps = Math.round(1000 / Math.max(1, avgInterval))
        const hud = hudRef.current
        if (hud) {
          hud.textContent =
            `fps ${fps} / ${avgInterval.toFixed(1)}ms` +
            ` / seq ${shownSeq} / mode ${currentMode}` +
            ` / speed ${speedLocal}x / particles ${particleCount}` +
            `${isPaused() ? ' / paused' : ''}`
        }
        const scrub = scrubRef.current
        if (scrub && !scrubbing) {
          const maxSeq = Math.max(liveEdge, oldestSeq)
          if (scrub.max !== String(maxSeq)) scrub.max = String(maxSeq)
          if (scrub.min !== String(oldestSeq)) scrub.min = String(oldestSeq)
          if (Number(scrub.value) !== shownSeq) scrub.value = String(shownSeq)
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
        liveEdge = msg.liveEdge
        oldestSeq = msg.oldestSeq

        if (msg.kind === 'tick') {
          shownSeq = liveEdge
        } else if (msg.kind === 'resize') {
          particleCount = msg.count
          currentMode = 'live'
          shownSeq = 0
          setCount(msg.count)
          setMode('live')
        } else if (msg.kind === 'seek') {
          // seek 到最新帧视为 live（继续推演）；否则进入 replay 停住等待。
          currentMode = msg.atEdge ? 'live' : 'replay'
          shownSeq = msg.seq // clamp 后的实际落点，滑块回弹到此值
          setMode(currentMode)
        }
      }
      // 首拍由 rAF 节拍在创建完成后发出；若当前已暂停则等恢复（或单步）。
      if (!isPaused()) requestTick(1)
    })

    // 暴露给 React 控件的命令式 API；cleanup 置空，StrictMode/重挂/HMR 无悬挂引用。
    apiRef.current = {
      setPaused: (v: boolean) => {
        userPausedLocal = v
      },
      setSpeed: (v: SpeedTier) => {
        speedLocal = v
      },
      stepOnce: () => {
        stepRequested = true
      },
      seekTo: (target: number) => {
        // 覆盖式单槽：rAF 发现空闲时发最新目标；在途则等当前命令回来再发。
        pendingSeek = target
      },
      goLive: () => {
        pendingSeek = liveEdge
      },
      requestCount: (nextCount: number) => {
        if (nextCount !== particleCount) pendingCount = nextCount
      },
      setScrubbing: (v: boolean) => {
        scrubbing = v
      },
    }

    return () => {
      disposed = true
      cancelAnimationFrame(rafId)
      resizeObserver.disconnect()
      intersectionObserver.disconnect()
      document.removeEventListener('visibilitychange', onVisibilityChange)
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', endPointer)
      canvas.removeEventListener('pointercancel', endPointer)
      if (worker) {
        worker.onmessage = null
        worker.terminate()
        worker = null
      }
      display = null
      apiRef.current = null
    }
  }, [])

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#111' }}>
      <canvas
        ref={canvasRef}
        style={{
          display: 'block',
          width: '100%',
          height: '100%',
          touchAction: 'none',
        }}
      />
      <div
        ref={hudRef}
        style={{ position: 'fixed', top: 8, left: 8, color: '#fff' }}
      >
        fps - / -ms / seq 0 / mode live / speed 1x / particles{' '}
        {DEFAULT_PARTICLE_COUNT}
      </div>
      <div
        style={{
          position: 'fixed',
          bottom: 12,
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          alignItems: 'center',
          background: 'rgba(0,0,0,0.45)',
          padding: '8px 12px',
          borderRadius: 8,
        }}
      >
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            type="button"
            onClick={() => {
              if (userPaused && mode === 'replay') {
                // 从 seek 落点继续推演：取消暂停并回到 live（下一拍起正常 tick）。
                apiRef.current?.goLive()
                setUserPaused(false)
                apiRef.current?.setPaused(false)
              } else {
                const next = !userPaused
                setUserPaused(next)
                apiRef.current?.setPaused(next)
              }
            }}
          >
            {userPaused ? '▶ 继续' : '⏸ 暂停'}
          </button>
          <button type="button" onClick={() => apiRef.current?.stepOnce()}>
            ⏭ 单步
          </button>
          {([0.25, 1, 4] as SpeedTier[]).map((tier) => (
            <button
              key={tier}
              type="button"
              style={{
                fontWeight: speed === tier ? 700 : 400,
                outline: speed === tier ? '2px solid #c084fc' : 'none',
              }}
              onClick={() => {
                setSpeed(tier)
                apiRef.current?.setSpeed(tier)
              }}
            >
              {tier}×
            </button>
          ))}
          <span style={{ color: '#aaa', fontSize: 12 }}>
            {mode === 'replay' ? '回放中' : '实时'}
          </span>
          <button
            type="button"
            disabled={mode === 'live'}
            onClick={() => apiRef.current?.goLive()}
          >
            ⏮ 回到实时
          </button>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ color: '#aaa', fontSize: 12 }}>回放</span>
          <input
            ref={scrubRef}
            type="range"
            min={0}
            max={0}
            step={1}
            defaultValue={0}
            style={{ width: 220 }}
            onPointerDown={() => {
              apiRef.current?.setScrubbing(true)
              // 拖拽前先暂停，避免 live 推进与滑块互相覆盖。
              if (!userPaused) {
                setUserPaused(true)
                apiRef.current?.setPaused(true)
              }
            }}
            onPointerUp={() => apiRef.current?.setScrubbing(false)}
            onPointerCancel={() => apiRef.current?.setScrubbing(false)}
            onChange={(e) => {
              apiRef.current?.seekTo(Number(e.target.value))
            }}
          />
          <span style={{ color: '#aaa', fontSize: 12 }}>粒子</span>
          {SIZE_TIERS.map((tier) => (
            <button
              key={tier}
              type="button"
              style={{
                fontWeight: count === tier ? 700 : 400,
                outline: count === tier ? '2px solid #c084fc' : 'none',
              }}
              onClick={() => {
                setCount(tier)
                apiRef.current?.requestCount(tier)
              }}
            >
              {tier >= 1000 ? `${tier / 1000}k` : tier}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

export default App


