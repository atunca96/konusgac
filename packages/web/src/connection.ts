import { CloseCode, GATEWAY_PATH, Op, type ClientFrame, type ServerFrame } from '@konusgac/shared';
import { getToken } from './api';
import { applyEvent, getState, setState } from './state';
import { markViewRead } from './actions';
import { notifyForMessage } from './notify';
import { onVoiceDispatch } from './voice';

// Single gateway link with heartbeat and exponential-backoff reconnect.
let ws: WebSocket | null = null;
let heartbeat: number | undefined;
let retry = 0;
let stopped = true;
let onAuthLost: () => void = () => {};

export function connect(authLost: () => void) {
  onAuthLost = authLost;
  stopped = false;
  open();
}

export function disconnect() {
  stopped = true;
  clearInterval(heartbeat);
  ws?.close();
  ws = null;
}

// Sends a frame if the link is up; voice frames are re-sent after READY on reconnect.
export function sendFrame(frame: ClientFrame) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
}

function open() {
  const token = getToken();
  if (!token || stopped) return;
  setState(() => ({ connection: 'connecting' }));
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${proto}://${location.host}${GATEWAY_PATH}`);
  ws = socket;

  socket.onmessage = (ev) => {
    const frame = JSON.parse(ev.data as string) as ServerFrame;
    switch (frame.op) {
      case Op.Hello:
        clearInterval(heartbeat);
        heartbeat = window.setInterval(() => socket.send(JSON.stringify({ op: Op.Heartbeat })), frame.d.heartbeatInterval);
        socket.send(JSON.stringify({ op: Op.Identify, d: { token } }));
        break;
      case Op.Dispatch:
        if (frame.t === 'READY') retry = 0;
        applyEvent(frame.t, frame.d);
        if (frame.t === 'MESSAGE_CREATE') {
          notifyForMessage(frame.d);
          if (frame.d.channelId === getState().view.channelId) markViewRead();
        }
        onVoiceDispatch(frame);
        break;
    }
  };

  socket.onclose = (ev) => {
    clearInterval(heartbeat);
    if (ws !== socket) return;
    ws = null;
    if (ev.code === CloseCode.AuthFailed) {
      stopped = true;
      onAuthLost();
      return;
    }
    if (stopped) return;
    setState(() => ({ connection: 'connecting' }));
    const delay = Math.min(30_000, 1000 * 2 ** retry++) * (0.5 + Math.random() / 2);
    setTimeout(open, delay);
  };
}
