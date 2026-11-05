      // Calculate accurate Market Cap
      const solPriceUsd = 200;
      const solReserves = event.vSolInBondingCurve || (event.virtualSolReserves ? event.virtualSolReserves / 1e9 : 0);
      const marketCapUsd = event.marketCapUsd || event.usd_market_cap || (solReserves > 0 ? solReserves * solPriceUsd * 5 : 0);

      // STRICTURE FILTER: Ignore raw 'create' dummy payloads; require actual 'buy' trade momentum
      if (marketCapUsd > 0 && event.txType === 'buy') {
        console.log(`🔎 Active Trade Token: ${mintAddress.slice(0, 6)}... | MC: $${marketCapUsd.toFixed(0)} | SOL: ${event.solAmount}`);

        if (marketCapUsd >= MIN_MARKET_CAP_USD && marketCapUsd <= MAX_MARKET_CAP_USD) {
          let stats = tokenMetrics.get(mintAddress);
          if (!stats) {
            stats = { buyCount: 0, volumeSol: 0 };
            tokenMetrics.set(mintAddress, stats);
          }

          stats.buyCount += 1;
          stats.volumeSol += Number(event.solAmount || 0.2);

          console.log(`🎯 SWEET SPOT BUY MATCH: ${mintAddress} | MC: $${marketCapUsd.toFixed(0)} | Buys: ${stats.buyCount} | Vol: ${stats.volumeSol.toFixed(2)} SOL`);

          // Require at least 2 separate buy events and 0.5 SOL volume to confirm a real upward wave
          if (stats.buyCount >= 2 && stats.volumeSol >= 0.5 && !processedMints.has(mintAddress)) {
            processedMints.add(mintAddress);
            tokenMetrics.delete(mintAddress);

            console.log(`🌊 MOMENTUM WAVE LOCKED: ${mintAddress} | MC: $${marketCapUsd.toFixed(0)} - Executing Buy...`);

            const buyTx = await executeLocalPumpSwap(mintAddress, TRADE_AMOUNT_SOL, 'buy');

            if (buyTx) {
              console.log(`✅ Wave buy completed for: ${mintAddress}`);
              
              activePositions.set(mintAddress, {
                entryMc: marketCapUsd,
                peakMc: marketCapUsd,
                entryTime: Date.now(),
                remainingTokens: TRADE_AMOUNT_SOL,
                tookPartialProfit: false
              });

              await sendTelegramAlert(
                `🌊 <b>Wave Entry Triggered</b>\n` +
                `Mint: <code>${mintAddress}</code>\n` +
                `Entry MC: <b>$${marketCapUsd.toFixed(0)}</b>\n` +
                `<a href="https://solscan.io/tx/${buyTx}">View Tx on Solscan</a>`
              );
            }
          }
        }
      }
