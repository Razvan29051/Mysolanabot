    // --- STEP 2: EXPONENTIAL VOLUME VELOCITY CHECK ---
    console.log(`⏳ [Volume Engine] Sampling baseline metrics for ${newMint.slice(0, 8)}...`);

    let solAtT0 = 0;
    let solAtT5 = 0;
    let solAtT15 = 0;

    // Sample T0 (Initial launch state)
    try {
      const res0 = await fetch(`https://frontend-api.pump.fun/coins/${newMint}`);
      if (res0.ok) solAtT0 = (await res0.json()).virtual_sol_reserves || 0;
    } catch (e) {}

    // Wait 5 seconds and sample T5
    await new Promise(resolve => setTimeout(resolve, 5000));
    try {
      const res5 = await fetch(`https://frontend-api.pump.fun/coins/${newMint}`);
      if (res5.ok) solAtT5 = (await res5.json()).virtual_sol_reserves || 0;
    } catch (e) {}

    // Wait remaining 10 seconds and sample T15
    await new Promise(resolve => setTimeout(resolve, 10000));
    try {
      const res15 = await fetch(`https://frontend-api.pump.fun/coins/${newMint}`);
      if (res15.ok) {
        const data15 = await res15.json();
        solAtT15 = data15.virtual_sol_reserves || 0;
        
        if (data15.complete) {
          console.log(`🚫 [Volume Filter] Curve completed during check. Skipping.`);
          isTrading = false;
          return;
        }
      }
    } catch (e) {}

    // Calculate volume velocity deltas (in SOL units)
    const initialGrowthSol = (solAtT5 - solAtT0) / 1e9;
    const secondaryGrowthSol = (solAtT15 - solAtT5) / 1e9;
    const totalGrowthSol = (solAtT15 - solAtT0) / 1e9;

    console.log(`📊 [Volume Stats] T0->T5: +${initialGrowthSol.toFixed(2)} SOL | T5->T15: +${secondaryGrowthSol.toFixed(2)} SOL | Total: +${totalGrowthSol.toFixed(2)} SOL`);

    // --- FILTER RULES ---
    // Rule A: Total SOL added must exceed at least 3 SOL (filters tiny micro-bot manipulation)
    const MIN_REQUIRED_GROWTH = 3.0; 
    
    // Rule B: Acceleration must be positive (volume in the last 10s must be faster than the first 5s)
    const isAccelerating = secondaryGrowthSol > (initialGrowthSol * 1.2);

    if (totalGrowthSol < MIN_REQUIRED_GROWTH) {
      console.log(`🚫 [Filter Skipped] Low volume growth (+${totalGrowthSol.toFixed(2)} SOL < ${MIN_REQUIRED_GROWTH} SOL target).`);
      isTrading = false;
      return;
    }

    if (!isAccelerating) {
      console.log(`🚫 [Filter Skipped] Volume is slowing down, not accelerating. Wave is dying.`);
      isTrading = false;
      return;
    }

    console.log(`🚀 [GREEN WAVE CONFIRMED] Accelerating volume detected! Deploying trade...`);
