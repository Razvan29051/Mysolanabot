    // --- BALANCED 12-SECOND MOMENTUM CHECK ---
    console.log(`⏳ [Volume Engine] Sampling baseline metrics for ${newMint.slice(0, 8)}...`);

    let solAtT0 = 0;
    let solAtT12 = 0;

    try {
      const res0 = await fetch(`https://frontend-api.pump.fun/coins/${newMint}`);
      if (res0.ok) solAtT0 = (await res0.json()).virtual_sol_reserves || 0;
    } catch (e) {}

    // Wait 12 seconds to observe organic buyer retention
    await new Promise(resolve => setTimeout(resolve, 12000));

    try {
      const res12 = await fetch(`https://frontend-api.pump.fun/coins/${newMint}`);
      if (res12.ok) {
        const data12 = await res12.json();
        solAtT12 = data12.virtual_sol_reserves || 0;
        
        if (data12.complete) {
          console.log(`🚫 [Volume Filter] Curve completed during check. Skipping.`);
          isTrading = false;
          return;
        }
      }
    } catch (e) {}

    const growthSol = (solAtT12 - solAtT0) / 1e9;
    console.log(`📊 [12s Growth Check] Net Growth: +${growthSol.toFixed(2)} SOL`);

    // Require at least 0.8 SOL of genuine net growth over 12 seconds
    if (growthSol < 0.8) {
      console.log(`🚫 [Skipped] Insufficient sustained volume (+${growthSol.toFixed(2)} SOL). Looking for next coin...`);
      isTrading = false;
      return;
    }

    console.log(`🚀 [Green Wave Validated] Sustained volume confirmed! Executing single-shot entry...`);
