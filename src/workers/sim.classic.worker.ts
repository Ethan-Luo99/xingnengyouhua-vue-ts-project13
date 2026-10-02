// classic worker 降级入口：供不支持 module worker 的浏览器回退。
// 逻辑与 module 入口完全一致，由 Vite 打包为独立 iife chunk，
// 严禁改为运行时拼接 import.meta.url 引用 .ts 源文件（生产构建会 404）。
import { installSim } from './sim-core'
import type { SimWorkerScope } from './sim-core'

installSim(self as unknown as SimWorkerScope)
