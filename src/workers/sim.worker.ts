import { installSim } from './sim-core'
import type { SimWorkerScope } from './sim-core'

installSim(self as unknown as SimWorkerScope)
