import React from 'react'
import { Radio } from 'lucide-react'

export default function ChannelView() {
  return (
    <div className="h-full flex flex-col items-center justify-center text-gray-400 gap-3">
      <Radio size={40} strokeWidth={1.5} />
      <p className="text-sm font-medium">Channels coming soon</p>
      <p className="text-xs text-gray-400 max-w-xs text-center">Connect Telegram, WhatsApp, WeChat and other channels — all conversations flow into Chat.</p>
    </div>
  )
}
