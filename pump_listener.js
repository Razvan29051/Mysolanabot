import WebSocket from 'ws';

// Loads your Helius WSS key safely from environment variables (NOT hardcoded)
const WS_URL = process.env.WS_URL;
const PUMP_FUN_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

if (!WS_URL) {
  console.error("❌ ERROR: WS_URL environment variable is missing!");
  process.exit(1);
}

function startListener() {
  console.log("⚡ [Pump.fun Listener] Connecting to real-time Solana WebSocket log stream...");
  const ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    console.log("🟢 [Connected] Subscribed to Pump.fun Program ID!");
    ws.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "logsSubscribe",
      params: [
        { mentions: [PUMP_FUN_PROGRAM_ID] },
        { commitment: "processed" }
      ]
    }));
  });

  ws.on('message', (data) => {
    try {
      const payload = JSON.parse(data.toString());
      if (!payload.params || !payload.params.result) return;

      const logs = payload.params.result.value.logs || [];
      const signature = payload.params.result.value.signature;

      // Check if the transaction created a new token bonding curve
      const isCreateTx = logs.some(log => log.includes("Instruction: Create"));

      if (isCreateTx) {
        console.log(`\n🚨 [NEW PUMP.FUN LAUNCH DETECTED!]`);
        console.log(`🔗 Transaction Link: https://solscan.io/tx/${signature}`);
      }
    } catch (e) {
      console.error("⚠️ Parse error:", e.message);
    }
  });

  ws.on('close', () => {
    console.log("🔴 WebSocket closed. Reconnecting in 3s...");
    setTimeout(startListener, 3000);
  });

  ws.on('error', (err) => {
    console.error("❌ WebSocket Error:", err.message);
  });
}

startListener();
