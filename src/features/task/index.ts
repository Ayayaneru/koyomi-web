import type { FeatureModule } from '../../core/contracts'
import { dueTasksIn, logsIn } from './due'
import {
  taskCompleteTask,
  taskCreateTask,
  taskDeleteTask,
  taskListTasks,
  taskQueryLogs
} from './tool'

const task: FeatureModule = {
  id: 'task',
  routes: [{ path: '/task', name: 'task', component: () => import('./TaskView.vue') }],
  homeEntry: { title: '任务', icon: 'task', to: '/task' },
  tools: [taskCreateTask, taskCompleteTask, taskListTasks, taskQueryLogs, taskDeleteTask],
  timeline: async ({ start, end }) => [...(await dueTasksIn(start, end)), ...(await logsIn(start, end))],
  // 2026-11-01：kind / intervalDays / dueAt / icon 的用法工具说明里都有，这里只留说法层面的
  defaultModulePrompt: `完成记录没有删除工具：用户要清理时，只说「完成记录只能你自己在任务页点那条记录前的 × 撤销」，不要答应删除、不要声称已删除，也别提议新建任务把旧记录盖住。`
}

export default task
