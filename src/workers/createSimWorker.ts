import type { SimWorkerMessage } from './protocol'

type ResolvedWorker = {
  worker: Worker
  kind: 'module' | 'classic'
}

// 能力探测：优先 module worker；构造同步抛错（如 iOS Safari<15）或引导失败
// （error 事件 / ready 握手超时）时回退 classic worker。
// 两个 new URL 都使用相对路径字符串字面量，确保 Vite 将其各自打包为带哈希的独立 worker
// 资源（非 .ts 直引），生产构建不会 404。
export function createSimWorker(): Promise<ResolvedWorker> {
  return new Promise((resolve) => {
    let settled = false
    let moduleWorker: Worker | null = null
    let preReadyError = false

    const fallback = () => {
      if (settled) return
      settled = true
      if (moduleWorker) moduleWorker.terminate()
      // classic 降级入口（Vite 以 IIFE 打包 sim.worker.classic.ts）。
      const classic = new Worker(
        new URL('./sim.worker.classic.ts', import.meta.url),
      )
      resolve({ worker: classic, kind: 'classic' })
    }

    try {
      moduleWorker = new Worker(
        new URL('./sim.worker.ts', import.meta.url),
        { type: 'module' },
      )
    } catch {
      moduleWorker = null
      fallback()
      return
    }

    const candidate = moduleWorker
    const timer = window.setTimeout(fallback, 1000)

    candidate.addEventListener('error', function onError() {
      // ready 握手完成前的错误（脚本加载/解析失败）才触发降级。
      if (settled) return
      preReadyError = true
      window.clearTimeout(timer)
      fallback()
    }, { once: true })

    candidate.addEventListener('message', function onReady(
      e: MessageEvent<SimWorkerMessage>,
    ) {
      if (settled || e.data?.type !== 'ready') return
      if (preReadyError) return
      window.clearTimeout(timer)
      settled = true
      candidate.removeEventListener('message', onReady)
      resolve({ worker: candidate, kind: 'module' })
    })
  })
}
