/**
 * 节次 → 时间。周日程表按「节次」排布，但 Event 只存起止时间，
 * 所以这里给一张固定表，只用于「图片识别导入」把节次换算成时间点。
 * 想改作息时间就改这张表；已经入库的日程不会跟着变（它们是具体时间）。
 */
export interface Period {
  index: number
  start: string
  end: string
}

export const PERIODS: Period[] = [
  { index: 1, start: '08:00', end: '08:45' },
  { index: 2, start: '08:55', end: '09:40' },
  { index: 3, start: '10:00', end: '10:45' },
  { index: 4, start: '10:55', end: '11:40' },
  { index: 5, start: '14:00', end: '14:45' },
  { index: 6, start: '14:55', end: '15:40' },
  { index: 7, start: '16:00', end: '16:45' },
  { index: 8, start: '16:55', end: '17:40' },
  { index: 9, start: '19:00', end: '19:45' },
  { index: 10, start: '19:55', end: '20:40' },
  { index: 11, start: '20:50', end: '21:35' },
  { index: 12, start: '21:45', end: '22:30' }
]

export function periodTime(index: number): { start: string; end: string } {
  const hit = PERIODS.find(p => p.index === index)
  return hit ?? PERIODS[0]
}
