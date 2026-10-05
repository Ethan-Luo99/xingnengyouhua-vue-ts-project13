// classic worker 入口（module worker 构造/引导失败时的降级项）。
// 该文件经 Vite 以 IIFE 打包为独立 worker 资源（构建产物有哈希文件名，非 .ts 直引，不会 404）。
import { bootstrapSimWorker } from './sim.worker.shared'

bootstrapSimWorker()
