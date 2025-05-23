import { useEffect, useRef, useState } from "react";

const ACCESS_CODE = "12345678"; // Shared code between broadcaster and viewer
const SIGNALING_SERVER_URL = `ws://localhost:8000/ws/signal/${ACCESS_CODE}/`;

const App = () => {
  const [role, setRole] = useState<"broadcaster" | "viewer" | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const pendingCandidates = useRef<RTCIceCandidateInit[]>([]);
  const messageQueue = useRef<{ type: string; data: any }[]>([]);
  const currentRole = useRef<"broadcaster" | "viewer" | null>(null);

  const log = (message: string) => {
    setLogs((prev) => [...prev, message]);
    console.log(message);
  };

  const flushMessageQueue = () => {
    while (messageQueue.current.length > 0) {
      const msg = messageQueue.current.shift();
      if (socketRef.current?.readyState === WebSocket.OPEN && msg) {
        socketRef.current.send(
          JSON.stringify({
            type: msg.type,
            data: msg.data,
            code: ACCESS_CODE,
            role: currentRole.current,
          })
        );
      } else {
        break;
      }
    }
  };

  const sendMessage = (type: string, data: any, role: string | null = null) => {
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.send(
        JSON.stringify({
          type,
          data,
          code: ACCESS_CODE,
          role: role ?? currentRole.current,
        })
      );
    } else {
      // Queue messages if WS not ready
      messageQueue.current.push({ type, data });
    }
  };

  const setupWebSocket = () => {
    socketRef.current = new WebSocket(SIGNALING_SERVER_URL);

    socketRef.current.onopen = () => {
      log("[WebSocket] Connected");
      // Send join message once connected
      if (currentRole.current) {
        socketRef.current?.send(
          JSON.stringify({
            type: "join",
            role: currentRole.current,
            code: ACCESS_CODE,
          })
        );
      }
      flushMessageQueue();
    };

    socketRef.current.onclose = () => log("[WebSocket] Disconnected");

    socketRef.current.onerror = () => log("[WebSocket] Error");

    socketRef.current.onmessage = async (event) => {
      const msg = JSON.parse(event.data);
      const { type, data, role: msgRole } = msg;

      const roleLog = msgRole ?? role ?? "unknown";

      switch (type) {
        case "join_ack":
          log(`[WebSocket] Join acknowledged: ${msg.message ?? "No message"}`);
          break;

        case "offer": {
          log(`[${roleLog}] Received offer`);
          if (!peerConnectionRef.current) {
            peerConnectionRef.current = createPeerConnection();
          }
          await peerConnectionRef.current.setRemoteDescription(
            new RTCSessionDescription(data)
          );
          const answer = await peerConnectionRef.current.createAnswer();
          await peerConnectionRef.current.setLocalDescription(answer);
          sendMessage("answer", answer, currentRole.current);
          // Add any queued ICE candidates now that remote SDP is set
          for (const candidate of pendingCandidates.current) {
            await peerConnectionRef.current.addIceCandidate(
              new RTCIceCandidate(candidate)
            );
          }
          pendingCandidates.current = [];
          break;
        }

        case "answer": {
          log(`[${roleLog}] Received answer`);
          await peerConnectionRef.current?.setRemoteDescription(
            new RTCSessionDescription(data)
          );
          // Add any queued ICE candidates now that remote SDP is set
          for (const candidate of pendingCandidates.current) {
            await peerConnectionRef.current?.addIceCandidate(
              new RTCIceCandidate(candidate)
            );
          }
          pendingCandidates.current = [];
          break;
        }

        case "ice-candidate": {
          log(`[${roleLog}] Received ICE candidate`);
          if (
            peerConnectionRef.current?.remoteDescription &&
            peerConnectionRef.current.remoteDescription.type
          ) {
            await peerConnectionRef.current.addIceCandidate(
              new RTCIceCandidate(data)
            );
          } else {
            pendingCandidates.current.push(data);
            log(
              `[${roleLog}] Queuing ICE candidate (remoteDescription not set)`
            );
          }
          break;
        }

        case "error": {
          log(
            `[WebSocket] Error from server: ${msg.message ?? "Unknown error"}`
          );
          break;
        }

        default:
          log(`[WebSocket] Unknown message type: ${type}`);
      }
    };
  };

  const createPeerConnection = () => {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        log("[Local] Sent ICE candidate");
        sendMessage("ice-candidate", event.candidate, currentRole.current);
      }
    };

    pc.ontrack = (event) => {
      log(
        `[${currentRole.current}] ontrack event: received ${event.streams.length} stream(s)`
      );
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = event.streams[0];
        remoteVideoRef.current.play().catch(() => {});
      }
    };

    return pc;
  };

  const startBroadcasting = async () => {
    currentRole.current = "broadcaster";
    setRole("broadcaster");
    setupWebSocket();

    peerConnectionRef.current = createPeerConnection();

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;

      stream.getTracks().forEach((track) => {
        peerConnectionRef.current?.addTrack(track, stream);
      });

      const offer = await peerConnectionRef.current.createOffer();
      await peerConnectionRef.current.setLocalDescription(offer);
      sendMessage("offer", offer, currentRole.current);
      log("[Broadcaster] Sent offer");
    } catch (err) {
      log("Error getting display media: " + (err as Error).message);
    }
  };

  const startViewing = () => {
    currentRole.current = "viewer";
    setRole("viewer");
    setupWebSocket();
    log("Starting app as viewer");
  };

  return (
    <div className="min-h-screen bg-gray-900 text-white p-4 flex flex-col items-center space-y-6">
      <h1 className="text-3xl font-bold">Screen Share App</h1>

      {!role && (
        <div className="space-x-4">
          <button
            className="px-6 py-2 bg-blue-600 rounded hover:bg-blue-700 transition"
            onClick={startBroadcasting}
          >
            Start as Broadcaster
          </button>
          <button
            className="px-6 py-2 bg-green-600 rounded hover:bg-green-700 transition"
            onClick={startViewing}
          >
            Start as Viewer
          </button>
        </div>
      )}

      <div className="flex flex-wrap gap-4 justify-center">
        <div>
          <h2 className="text-lg mb-1">Local Video</h2>
          <video
            ref={localVideoRef}
            autoPlay
            muted
            playsInline
            className="w-72 h-40 bg-black rounded"
          />
        </div>
        <div>
          <h2 className="text-lg mb-1">Remote Video</h2>
          <video
            ref={remoteVideoRef}
            autoPlay
            playsInline
            className="w-72 h-40 bg-black rounded"
          />
        </div>
      </div>

      <div className="w-full max-w-2xl mt-6">
        <h2 className="text-lg mb-2">Logs</h2>
        <div className="bg-black rounded p-3 h-48 overflow-y-auto text-sm space-y-1 border border-gray-700">
          {logs.map((log, index) => (
            <div key={index}>{log}</div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default App;
