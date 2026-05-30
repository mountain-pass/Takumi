import React from 'react'
import { MessageSquare } from 'lucide-react'

export default function ChatView() {
  return (
    <div className="h-full flex flex-col items-center justify-center text-gray-400 gap-3">
      <MessageSquare size={40} strokeWidth={1.5} />
      <p className="text-sm font-medium">Chat coming soon</p>
      <p className="text-xs text-gray-400 max-w-xs text-center">This will be the main entry point to interact with your agents.</p>
    </div>
  )
}
