"""Messaging channels — let users talk to the platform from Telegram/Slack/etc.

Inbound messages route into the SAME Manager brain (ceo.chat_with_context) as the
web Chat, so the agent has full platform knowledge, and replies go back out to the
originating channel. See service.ChannelService for the routing + omni-channel digest.
"""
from .service import channel_service

__all__ = ["channel_service"]
