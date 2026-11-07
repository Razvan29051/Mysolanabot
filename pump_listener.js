function startCodex() {
  if (!CODEX_API_KEY) {
    log('⚠️ No CODEX_API_KEY – skipping Codex');
    return;
  }

  log('Connecting to Codex...');

  const ws = new WebSocket('wss://graph.codex.io/graphql', {
    headers: {
      'Sec-WebSocket-Protocol': 'graphql-transport-ws'
    }
  });

  ws.on('open', () => {
    log('Codex socket opened – sending auth...');
    
    // Send connection_init
    ws.send(JSON.stringify({
      type: 'connection_init',
      payload: {
        Authorization: CODEX_API_KEY
      }
    }));
  });

  ws.on('message', async (data) => {
    const msg = JSON.parse(data.toString());
    
    // Log every message type for debugging
    log(`Codex message type: ${msg.type}`);

    if (msg.type === 'connection_ack') {
      log('🟢 Codex authenticated successfully');

      // Subscribe
      ws.send(JSON.stringify({
        id: 'pump',
        type: 'subscribe',
        payload: {
          query: `
            subscription {
              onLaunchpadTokenEventBatch(
                input: {
                  protocol: Pump
                  networkId: 1399811149
                }
              ) {
                eventType
                address
                marketCap
                buyCount1
                sellCount1
                volume1
                token {
                  name
                  symbol
                  address
                }
              }
            }
          `
        }
      }));
      return;
    }

    if (msg.type === 'error') {
      log(`❌ Codex error: ${JSON.stringify(msg.payload)}`);
      return;
    }

    if (msg.type === 'next' && msg.payload?.data?.onLaunchpadTokenEventBatch) {
      const events = msg.payload.data.onLaunchpadTokenEventBatch;
      log(`Codex received ${events.length} events`);

      for (const ev of events) {
        const mint = ev.address || ev.token?.address;
        if (!mint || processed.has(mint) || activePosition || isBuying) continue;

        const mc = parseFloat(ev.marketCap || 0);
        const buys = ev.buyCount1 || 0;

        log(`Codex → ${ev.token?.symbol || mint.slice(0,6)} | MC $${Math.round(mc)} | Buys ${buys}`);

        if (mc >= MIN_MC && mc <= MAX_MC && buys >= MIN_BUY_COUNT) {
          processed.add(mint);
          const amount = Math.min(await getBalance(), MAX_BUY_SOL);
          if (amount < 0.06) continue;

          isBuying = true;
          log(`🚀 CODEX BUY ${amount} SOL`);
          const tx = await swap(mint, amount, 'buy');
          isBuying = false;

          if (tx) {
            activePosition = { mint, entryMc: mc, entryTime: Date.now() };
            await sendTelegram(`🚀 <b>CODEX ENTRY</b>\n<code>${mint}</code>\nMC: $${Math.round(mc)}\nBuys: ${buys}`);
          }
        }
      }
    }
  });

  ws.on('close', (code, reason) => {
    log(`Codex closed (code ${code}) – ${reason || 'no reason'} – reconnecting in 6s`);
    setTimeout(startCodex, 6000);
  });

  ws.on('error', (err) => {
    log(`Codex error: ${err.message}`);
  });
}
