import React from 'react'
import { CalendarClock } from 'lucide-react'

export default function CronJobView() {
  return (
    <div className="h-full flex flex-col items-center justify-center text-gray-400 gap-3">
      <CalendarClock size={40} strokeWidth={1.5} />
      <p className="text-sm font-medium">Cron Jobs coming soon</p>
      <p className="text-xs text-gray-400 max-w-xs text-center">Schedule reminders, notes, and complex agent tasks to run at specific times.</p>
    </div>
  )
}
