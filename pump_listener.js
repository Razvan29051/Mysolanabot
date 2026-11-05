// ========== IMPROVED POSITION MANAGER ==========
async function monitorAndRideSinglePosition(tokenMint, buyAmountUnits, initialSolSpent) {
  console.log(`👀 [Position Manager] Tracking ${tokenMint.slice(0, 8)}...`);
  
  let peakValue = initialSolSpent;
  let remainingUnits = BigInt(buyAmountUnits);
  let hasTakenPartial = false;
  const startTime = Date.now();
  const maxHoldTimeMs = 4 * 60 * 1000; // 4 minutes

  const checkInterval = setInterval(async () => {
    try {
      if (remainingUnits <= 0n) {
        clearInterval(checkInterval);
        return;
      }

      const quoteRes = await safeFetch(
        `https://api.jup.ag/swap/v1/quote?inputMint=${tokenMint}&outputMint=${SOL_MINT}&amount=${remainingUnits.toString()}&slippageBps=500`
      );
      const quote = await quoteRes.json();
      if (!quote || quote.error) return;

      const currentValueSol = parseInt(quote.outAmount) / 1e9;
      if (currentValueSol > peakValue) peakValue = currentValueSol;

      const pnlPct = ((currentValueSol / initialSolSpent) - 1) * 100;
      const color = pnlPct >= 0 ? '\x1b[32m' : '\x1b[31m'; // green / red
      console.log(`${color}📈 Current: ${currentValueSol.toFixed(4)} SOL | Peak: ${peakValue.toFixed(4)} SOL | PnL: ${pnlPct.toFixed(1)}%\x1b[0m`);

      // === Partial take-profit at +15% ===
      if (!hasTakenPartial && currentValueSol >= initialSolSpent * 1.15) {
        const sellUnits = remainingUnits * 60n / 100n; // sell 60%
        if (sellUnits > 0n) {
          console.log(`\x1b[32m💰 [PARTIAL PROFIT] Selling 60% at +15%+\x1b[0m`);
          await executeSwap(tokenMint, SOL_MINT, sellUnits.toString());
          remainingUnits -= sellUnits;
          hasTakenPartial = true;
        }
      }

      // === Trailing & stop logic ===
      const activatedTrail = peakValue >= initialSolSpent * 1.08; // only trail after +8%
      const pulledBackFromPeak = activatedTrail && currentValueSol < peakValue * 0.88;
      const hitStopLoss = currentValueSol <= initialSolSpent * 0.93; // –7%
      const timedOut = Date.now() - startTime > maxHoldTimeMs;

      if (pulledBackFromPeak || hitStopLoss || timedOut) {
        clearInterval(checkInterval);
        
        const reason = pulledBackFromPeak 
          ? `\x1b[32m🟢 [TRAILING EXIT] Locked gains from peak\x1b[0m`
          : hitStopLoss 
            ? `\x1b[31m🚨 [STOP-LOSS]\x1b[0m` 
            : `\x1b[33m⏰ [TIMEOUT]\x1b[0m`;

        console.log(reason);
        
        if (remainingUnits > 0n) {
          const sellTxid = await executeSwap(tokenMint, SOL_MINT, remainingUnits.toString());
          console.log(`\x1b[32m✅ [POSITION CLOSED] https://solscan.io/tx/${sellTxid}\x1b[0m`);
        }
        
        isTrading = false;
        console.log(`🔄 Wallet unlocked for next target.`);
      }
    } catch (e) {
      // silent
    }
  }, 4500); // slightly faster polling
}
