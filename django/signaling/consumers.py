import json
from channels.generic.websocket import AsyncWebsocketConsumer


class SignalingConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        # Expect code in query string or URL (adjust as needed)
        self.room_name = self.scope["url_route"]["kwargs"]["room_name"]
        self.room_group_name = f"signal_{self.room_name}"

        # Add user to the group
        await self.channel_layer.group_add(self.room_group_name, self.channel_name)
        await self.accept()

        # Optional: store role after join message arrives
        self.role = None

    async def disconnect(self, close_code):
        # Remove from group on disconnect
        await self.channel_layer.group_discard(self.room_group_name, self.channel_name)

    async def receive(self, text_data):
        data = json.loads(text_data)
        msg_type = data.get("type")
        self.role = data.get("role")  # Save role for this connection
        code = data.get("code")

        if code != self.room_name:
            # Invalid room code, ignore message
            return

        if msg_type == "join":
            # Acknowledge join with optional message
            await self.send(
                text_data=json.dumps(
                    {
                        "type": "join_ack",
                        "message": "Join acknowledged",
                        "role": self.role,
                        "code": self.room_name,
                    }
                )
            )
            return

        # Broadcast signaling messages to other group members
        if msg_type in ["offer", "answer", "ice-candidate"]:
            # Remove sender role to avoid echo to self
            await self.channel_layer.group_send(
                self.room_group_name,
                {
                    "type": "signal.message",
                    "message": {
                        "type": msg_type,
                        "data": data.get("data"),
                        "role": self.role,
                        "code": self.room_name,
                    },
                    "sender_channel": self.channel_name,
                },
            )
        else:
            # Unknown message type: optionally send error back
            await self.send(
                text_data=json.dumps(
                    {
                        "type": "error",
                        "message": f"Unknown message type: {msg_type}",
                        "code": self.room_name,
                    }
                )
            )

    async def signal_message(self, event):
        message = event["message"]
        sender_channel = event.get("sender_channel")

        # Don't send message back to sender
        if self.channel_name == sender_channel:
            return

        await self.send(text_data=json.dumps(message))
