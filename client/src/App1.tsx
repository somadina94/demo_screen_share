import { useEffect, useRef, useState } from "react";

const SERVER_URL = "ws://localhost:4000"; // adjust for your env
const role = new URLSearchParams(window.location.search).get("role"); // "broadcaster" or "viewer"

const iceServers = [
  { urls: ["stun:fr-turn3.xirsys.com"] },
  {
    username:
      "e5fQaBUDXOmmdH7fa1V_ho7GZcaTh8vWUhlpNN9pvB907xILRFrfRLM69f_Ba1MdAAAAAGgqZH5qYWhieXRl",
    credential: "aa78979e-343a-11f0-ad4d-0242ac120004",
    urls: [
      "turn:fr-turn3.xirsys.com:80?transport=udp",
      "turn:fr-turn3.xirsys.com:3478?transport=udp",
      "turn:fr-turn3.xirsys.com:80?transport=tcp",
      "turn:fr-turn3.xirsys.com:3478?transport=tcp",
      "turns:fr-turn3.xirsys.com:443?transport=tcp",
      "turns:fr-turn3.xirsys.com:5349?transport=tcp",
    ],
  },
];

const App = () => {
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const pc = useRef<RTCPeerConnection | null>(null);
  const ws = useRef<WebSocket | null>(null);
  const [started, setStarted] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const candidateQueue = useRef<RTCIceCandidateInit[]>([]);

  const logMsg = (msg: string) => setLog((prev) => [...prev, msg]);

  useEffect(() => {
    if (!role) {
      logMsg("No role specified in URL params");
      return;
    }

    logMsg(`Starting app as ${role}`);

    ws.current = new WebSocket(SERVER_URL);

    pc.current = new RTCPeerConnection({ iceServers });

    ws.current.onopen = () => {
      logMsg("[WebSocket] Connected");
    };

    ws.current.onerror = (e) => {
      logMsg("[WebSocket] Error");
      console.error(e);
    };

    ws.current.onclose = () => {
      logMsg("[WebSocket] Disconnected");
    };

    ws.current.onmessage = async (event) => {
      try {
        const message = JSON.parse(event.data);
        const { type, data } = message;

        if (!pc.current) return;

        switch (type) {
          case "offer":
            if (role !== "viewer") return;
            logMsg("[Viewer] Received offer");
            try {
              await pc.current.setRemoteDescription(
                new RTCSessionDescription(data)
              );
              logMsg("[Viewer] Remote description set");

              // Add any queued ICE candidates now
              for (const candidate of candidateQueue.current) {
                try {
                  await pc.current.addIceCandidate(
                    new RTCIceCandidate(candidate)
                  );
                  logMsg("[Viewer] Added queued ICE candidate");
                } catch (e) {
                  logMsg(
                    "[Viewer] Failed to add queued ICE candidate: " +
                      (e as Error).message
                  );
                }
              }
              candidateQueue.current = [];

              const answer = await pc.current.createAnswer();
              await pc.current.setLocalDescription(answer);
              sendMessage("answer", answer);
              logMsg("[Viewer] Sent answer");
            } catch (e) {
              logMsg(
                "[Viewer] Failed to set remote description: " +
                  (e as Error).message
              );
            }
            break;

          case "answer":
            if (role !== "broadcaster") return;
            logMsg("[Broadcaster] Received answer");
            try {
              await pc.current.setRemoteDescription(
                new RTCSessionDescription(data)
              );
              logMsg("[Broadcaster] Remote description set");
            } catch (e) {
              logMsg(
                "[Broadcaster] Failed to set remote description: " +
                  (e as Error).message
              );
            }
            break;

          case "ice-candidate": {
            if (!pc.current) return;
            const candidate = data as RTCIceCandidateInit;
            if (
              !pc.current.remoteDescription ||
              pc.current.remoteDescription.type === null
            ) {
              // Remote description not set yet, queue candidate
              candidateQueue.current.push(candidate);
              logMsg(
                `[${role}] Queuing ICE candidate (remoteDescription not set)`
              );
            } else {
              try {
                await pc.current.addIceCandidate(
                  new RTCIceCandidate(candidate)
                );
                logMsg(`[${role}] ICE candidate added`);
              } catch (e) {
                logMsg(
                  `[${role}] Failed to add ICE candidate: ` +
                    (e as Error).message
                );
              }
            }
            break;
          }

          default:
            logMsg(`[WebSocket] Unknown message type: ${type}`);
        }
      } catch (err) {
        logMsg("[WebSocket] Failed to parse message");
        console.error(err);
      }
    };

    pc.current.onicecandidate = (event) => {
      if (event.candidate) {
        sendMessage("ice-candidate", event.candidate.toJSON());
        logMsg("[Local] Sent ICE candidate");
      }
    };

    pc.current.oniceconnectionstatechange = () => {
      const state = pc.current?.iceConnectionState || "unknown";
      logMsg(`[ICE State] ${state}`);
      if (state === "failed" || state === "disconnected") {
        logMsg("[ICE] Connection lost or failed");
      }
    };

    pc.current.ontrack = (event) => {
      const [remoteStream] = event.streams;
      logMsg("[Viewer] ontrack fired, remoteStream received");

      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = remoteStream;
        remoteVideoRef.current.onloadedmetadata = () => {
          logMsg("[Viewer] Metadata loaded, attempting to play remote video");
          remoteVideoRef.current
            ?.play()
            .then(() => logMsg("[Viewer] Remote video playing"))
            .catch((err) => logMsg("[Viewer] Play error: " + err.message));
        };
      }
    };

    return () => {
      logMsg("Cleaning up connection...");
      ws.current?.close();
      pc.current?.close();
    };
  }, []);

  const sendMessage = (type: string, data: unknown) => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify({ type, data }));
    }
  };

  const startBroadcast = async () => {
    if (!pc.current) return;
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
      });
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;

      stream.getTracks().forEach((track) => {
        pc.current?.addTrack(track, stream);
      });

      const offer = await pc.current.createOffer();
      await pc.current.setLocalDescription(offer);
      sendMessage("offer", offer);
      logMsg("[Broadcaster] Sent offer");
      setStarted(true);
    } catch (err) {
      logMsg("[Error] Unable to start broadcast: " + (err as Error).message);
    }
  };

  const playRemoteVideo = () => {
    if (!remoteVideoRef.current) {
      logMsg("[Viewer] No remote video element found");
      return;
    }
    remoteVideoRef.current
      .play()
      .then(() => logMsg("[Viewer] Remote video manually started"))
      .catch((err) => logMsg("[Viewer] Play error: " + err.message));
  };

  return (
    <div className="p-4 space-y-4">
      <h1 className="text-xl font-bold">Role: {role}</h1>

      {role === "broadcaster" && (
        <button
          onClick={startBroadcast}
          disabled={started}
          className="px-4 py-2 bg-blue-600 text-white rounded cursor-pointer"
        >
          {started ? "Sharing..." : "Start Screen Share"}
        </button>
      )}

      <div className="mx-auto gap-4">
        {role === "broadcaster" && (
          <div>
            <h2 className="font-semibold">Local Video</h2>
            {started && (
              <p className="text-sm text-white">
                You're sharing your screen. Leave this page or hide the preview
                to avoid visual artifacts.
              </p>
            )}
            {!started && (
              <video
                ref={localVideoRef}
                autoPlay
                muted
                playsInline
                className="w-full h-64 md:h-[70vh] bg-black object-contain rounded"
              />
            )}
          </div>
        )}

        {role === "viewer" && (
          <div>
            <h2 className="font-semibold">Remote Video</h2>
            <video
              ref={remoteVideoRef}
              autoPlay
              playsInline
              muted
              className="w-full h-64 md:h-[70vh] bg-black object-contain rounded"
            />
          </div>
        )}
      </div>

      {role === "viewer" && (
        <button
          onClick={playRemoteVideo}
          className="px-4 py-2 bg-blue-600 text-white rounded cursor-pointer"
        >
          Click to Play Remote Stream
        </button>
      )}

      <div className="bg-gray-900 text-green-300 p-2 text-sm overflow-auto h-48 rounded">
        <pre>{log.join("\n")}</pre>
      </div>
    </div>
  );
};

export default App;
