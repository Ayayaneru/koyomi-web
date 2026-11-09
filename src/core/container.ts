import type { FeatureModule } from './contracts'
import llm from '../features/llm'
import schedule from '../features/schedule'
import task from '../features/task'
import vault from '../features/vault'

/** 唯一的模块注册表。删模块只删目录 + 这里一行。 */
export const modules: FeatureModule[] = [llm, schedule, task, vault]

export const allTools = modules.flatMap(m => m.tools ?? [])

export const moduleById = new Map(modules.map(m => [m.id, m]))

/** 预期的 moduleId；启动时比对，防止「忘了注册、界面静悄悄消失」 */
const EXPECTED_IDS = ['llm', 'schedule', 'task', 'vault']

export function assertModules(): void {
  const actual = modules.map(m => m.id)
  if (actual.join(',') !== EXPECTED_IDS.join(',')) {
    console.error('[koyomi] 模块注册与预期不一致', { expected: EXPECTED_IDS, actual })
  }
  const names = allTools.map(t => t.name)
  const duplicated = names.filter((name, i) => names.indexOf(name) !== i)
  if (duplicated.length) console.error('[koyomi] 工具名重复', duplicated)
  const badName = names.filter(n => !/^[a-zA-Z0-9_-]{1,64}$/.test(n))
  if (badName.length) console.error('[koyomi] 工具名不符合 OpenAI 规则', badName)
}
