from django.urls import re_path
from .consumers import SignalingConsumer

websocket_urlpatterns = [
    re_path(r"ws/signal/(?P<room_name>\w+)/$", SignalingConsumer.as_asgi()),
]
