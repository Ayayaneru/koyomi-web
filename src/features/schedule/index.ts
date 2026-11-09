import type { FeatureModule } from '../../core/contracts'
import { db } from '../../core/db'
import { expandEvents } from './expand'
import {
  scheduleCreateEvent,
  scheduleDeleteEvent,
  scheduleQueryEvents,
  scheduleUpdateEvent
} from './tool'

const schedule: FeatureModule = {
  id: 'schedule',
  routes: [
    { path: '/schedule', name: 'schedule', component: () => import('./ScheduleView.vue') },
    { path: '/schedule/import', name: 'schedule-import', component: () => import('./ImportView.vue') }
  ],
  homeEntry: { title: '日程', icon: 'calendar', to: '/schedule' },
  tools: [scheduleCreateEvent, scheduleUpdateEvent, scheduleQueryEvents, scheduleDeleteEvent],
  timeline: async ({ start, end }) => {
    const rows = await db.events.where('startAt').below(end).toArray()
    return expandEvents(rows, start, end)
  },
  // 2026-11-01：时间格式、单双周取值这些工具说明里都写了，这里只留「说法/顺序」这类约束
  defaultModulePrompt: `改或删已有日程前，先用 schedule_query_events 找到它的 id，不要凭印象编一个。`
}

export default schedule
