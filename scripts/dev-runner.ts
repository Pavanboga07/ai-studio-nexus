// ============================================================================
// AI Nexus Workspace Process Orchestrator (`scripts/dev-runner.ts`)
// Launches and supervises the two strictly independent application processes:
// - Application B: `ai-nexus-gateway` on http://localhost:4000 (ws://localhost:4000/ws/node)
// - Application A: `ai-nexus-chatbot` on http://localhost:3000
//
// Each application runs in its own isolated OS process with its own PID,
// entrypoint, Express instance, and port.
// To stop the Gateway independently for offline/reconnection testing:
//   touch /tmp/ai-nexus-gateway.disabled && pkill -f "gatewayMain.ts"
// To restart the Gateway independently:
//   rm -f /tmp/ai-nexus-gateway.disabled
// ============================================================================

import { spawn, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const DISABLE_GATEWAY_SENTINEL = '/tmp/ai-nexus-gateway.disabled';

function isPortListening(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(600);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, host);
  });
}

let gatewayProc: ChildProcess | null = null;
let chatbotProc: ChildProcess | null = null;
let shuttingDown = false;

async function ensureGatewayProcess(): Promise<void> {
  if (shuttingDown) return;

  if (fs.existsSync(DISABLE_GATEWAY_SENTINEL)) {
    if (gatewayProc && !gatewayProc.killed) {
      gatewayProc.kill('SIGTERM');
      gatewayProc = null;
    }
    return;
  }

  const alreadyListening = await isPortListening(4000);
  if (alreadyListening) {
    return;
  }

  if (gatewayProc && !gatewayProc.killed && gatewayProc.exitCode === null) {
    return;
  }

  const tsxBin = path.resolve(process.cwd(), 'node_modules/.bin/tsx');
  const gatewayEntry = path.resolve(
    process.cwd(),
    'ai-nexus-gateway/src/server/gatewayMain.ts'
  );

  gatewayProc = spawn(tsxBin, [gatewayEntry], {
    cwd: path.resolve(process.cwd(), 'ai-nexus-gateway'),
    env: {
      ...process.env,
      PORT: '4000',
      GATEWAY_PORT: '4000',
      HOST: '0.0.0.0',
      ALLOWED_ORIGINS: 'http://localhost:3000,http://127.0.0.1:3000,*',
      NODE_WS_PATH: '/ws/node',
    },
    stdio: 'inherit',
  });

  gatewayProc.on('exit', () => {
    gatewayProc = null;
  });
}

async function startChatbotProcess(): Promise<void> {
  const alreadyListening = await isPortListening(3000);
  if (alreadyListening) {
    return;
  }

  const tsxBin = path.resolve(process.cwd(), 'node_modules/.bin/tsx');
  const chatbotEntry = path.resolve(process.cwd(), 'src/server/chatbotMain.ts');

  chatbotProc = spawn(tsxBin, [chatbotEntry, '--port', '3000'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: '3000',
      CHATBOT_PORT: '3000',
      HOST: '0.0.0.0',
      DISABLE_HMR: 'true',
      GATEWAY_INTERNAL_URL: 'http://localhost:4000',
      VITE_GATEWAY_HTTP_URL: 'http://localhost:4000',
      VITE_GATEWAY_WS_URL: 'ws://localhost:4000/ws/node',
    },
    stdio: 'inherit',
  });

  chatbotProc.on('exit', (code) => {
    if (!shuttingDown) {
      process.exit(code ?? 0);
    }
  });
}

async function main() {
  // Remove any stale sentinel on fresh dev server boot
  try {
    if (fs.existsSync(DISABLE_GATEWAY_SENTINEL)) {
      fs.unlinkSync(DISABLE_GATEWAY_SENTINEL);
    }
  } catch {
    // ignore
  }

  await ensureGatewayProcess();
  await startChatbotProcess();

  // Monitor Gateway sentinel / port 4000 every 1.5s so Gateway can be toggled or auto-restarted
  const monitor = setInterval(() => {
    ensureGatewayProcess().catch(() => {});
  }, 1500);

  const cleanup = () => {
    shuttingDown = true;
    clearInterval(monitor);
    if (chatbotProc && !chatbotProc.killed) {
      chatbotProc.kill('SIGTERM');
    }
    if (gatewayProc && !gatewayProc.killed) {
      gatewayProc.kill('SIGTERM');
    }
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

main().catch((err) => {
  console.error('[dev-runner] Failed to launch processes:', err);
  process.exit(1);
});
