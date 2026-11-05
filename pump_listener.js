// --- MAIN WEBSOCKET LISTENER ---
function startWebSocket() {
  const ws = new WebSocket(WSS_ENDPOINT);

  ws.on('open', () => {
    console.log('⚡ Connected to Solana WSS Stream');
    // Notice: We removed the startup telegram alert from here so it doesn't spam on reconnect!
    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'logsSubscribe',
      params: [
        { mentions: [PUMP_FUN_PROGRAM_ID.toString()] },
        { commitment: 'confirmed' }
      ]
    }));
  });

  ws.on('message', async (data) => {
    const now = Date.now();
    if (now - lastProcessedTime < 2500) return; // 2.5s rate-limit throttling
    lastProcessedTime = now;

    try {
      const response = JSON.parse(data);
      if (!response.params?.result?.value) return;

      const logs = response.params.result.value.logs || [];
      const signature = response.params.result.value.signature;

      for (const log of logs) {
        if (log.includes('Instruction: Buy') || log.includes('Instruction: Create')) {
          const txInfo = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
          if (!txInfo) continue;

          const mintAddress = txInfo.transaction.message.accountKeys.find(a => a.writable && !a.signer)?.pubkey?.toString();
          if (!mintAddress || activePositions.has(mintAddress)) continue;

          const isQualified = await evaluateToken(mintAddress);
          if (isQualified) {
            activePositions.set(mintAddress, true);

            await sendTelegramAlert(
              `🎯 <b>Momentum Target Found!</b>\n` +
              `Mint: <code>${mintAddress}</code>\n` +
              `Executing buy order...`
            );

            const buyTx = await executeSwap('So11111111111111111111111111111111111111112', mintAddress, TRADE_AMOUNT_SOL * 1e9);

            if (buyTx) {
              await sendTelegramAlert(
                `✅ <b>Buy Order Executed</b>\n` +
                `Bought: ${TRADE_AMOUNT_SOL} SOL\n` +
                `<a href="https://solscan.io/tx/${buyTx}">View Tx on Solscan</a>`
              );
              monitorPosition(mintAddress, TRADE_AMOUNT_SOL, 1000000);
            } else {
              activePositions.delete(mintAddress);
            }
          }
        }
      }
    } catch (err) {
      // Catch parse errors quietly
    }
  });

  ws.on('error', (err) => {
    console.error('WSS Error:', err.message);
  });

  ws.on('close', () => {
    console.log('⚠️ WebSocket disconnected. Reconnecting in 3 seconds...');
    setTimeout(startWebSocket, 3000);
  });
}

// --- BOT INITIALIZATION ---
async function main() {
  console.log(`🔑 Momentum Rider Active: ${wallet.publicKey.toString()}`);

  // This will now ONLY run once when the app container boots up for the very first time!
  await sendTelegramAlert(
    `🚀 <b>Momentum Rider Bot Online</b>\n` +
    `Wallet: <code>${wallet.publicKey.toString()}</code>\n` +
    `Status: Scanning Pump.fun tokens (25%-78% curve)...`
  );

  startWebSocket();
}

main();
