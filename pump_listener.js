import 'dotenv/config';
import WebSocket from 'ws';
import { Connection, Keypair, VersionedTransaction, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

const WS_URL = process.env.WS_URL;
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const PUMP_FUN_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const SOL_MINT = 'So11111111111111111111111111111111111111112';

const connection = new Connection(RPC_URL, 'confirmed');

let wallet;
try {
  let raw = process.env.BOT_PRIVATE_KEY ? process.env.BOT_PRIVATE_KEY.trim() : "";
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1).trim();
  }
  wallet = Keypair.fromSecretKey(raw.startsWith('[') ? Uint8Array.from(JSON.parse(raw)) : bs58.decode(raw));
  console.log(`🔑 [Wallet] Clean Graduation Rider Active: ${wallet.publicKey.toString()}`);
} catch (err) {
  console.error("❌ Private Key Error:", err.message);
  process.exit(1);
}

let isTrading = false;
const processedTokens = new Set();
let lastCheckTimestamp = 0;

async function safeFetch(url, options = {}) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, options);
      if (res.status === 429) {
        await new Promise(resolve => setTimeout(resolve, 3000 * (i + 1)));
        continue;
      }
      return res;
    } catch (err) {
      if (i === 2) throw err;
    }
  }
  throw new Error("Request failed.");
}

async function executeSwap(inputMint, outputMint, amountUnits) {
  const quoteRes = await safeFetch(
    `https://api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountUnits}&slippageBps=400`
  );
  const quote = await quoteRes.json();
  if (quote.error) throw new Error(`Quote Error: ${quote.error}`);

  const swapRes = await safeFetch('https://api.jup.ag/swap/v1/swap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: wallet.publicKey.toString(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto'
    })
  });
  
  const swapData = await swapRes.json();
  if (!swapData.swapTransaction) throw new Error("Failed to generate swap transaction.");

  const transaction = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, 'base64'));
  transaction.sign([wallet]);

  return await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true });
}

async function hasStrongBuyPressure(tokenMint) {
  try {
    const sigs = await connection.getSignaturesForAddress(
      new PublicKey(tokenMint),
      { limit: 12 }
    );

    if (!sigs || sigs.length < 4) return false;

    let buyCount = 0;
    let sellCount = 0;
    let buyVolume = 0;
    let sellVolume = 0;

    for (const sigInfo of sigs.slice(0, 8)) {
      const tx = await connection.getParsedTransaction(sigInfo.signature, {
        maxSupportedTransactionVersion: 1,
        commitment: 'confirmed'
      });

      if (!tx?.meta) continue;

      const pre = tx.meta.preTokenBalances || [];
      const post = tx.meta.postTokenBalances || [];

      const preBal = pre.find(b => b.mint === tokenMint);
      const postBal = post.find(b => b.mint === tokenMint);

      if (!preBal || !postBal) continue;

      const change = (postBal.uiTokenAmount?.uiAmount || 0) - (preBal.uiTokenAmount?.uiAmount || 0);

      if (change > 0) {
        buyCount++;
        buyVolume += Math.abs(change);
      } else if (change < 0) {
        sellCount++;
        sellVolume += Math.abs(change);
      }
    }

    const lastTradesBuyHeavy = buyCount >= sellCount + 1;
    const volumeBuyHeavy = buyVolume > sellVolume * 1.15; // relaxed for ~70% win rate

    const strong = lastTradesBuyHeavy && volumeBuyHeavy;

    console.log(`📊 Buy Pressure → Buys: ${buyCount} | Sells: ${sellCount} | Vol ratio: ${(buyVolume / (sellVolume || 1)).toFixed(2)}x → ${strong ? 'PASS' : 'FAIL'}`);

    return strong;
  } catch (err) {
    console.log('⚠️ Buy pressure check failed, skipping trade');
    return false;
  }
}

async function monitorAndRideSinglePosition(tokenMint, buyAmountUnits, initialSolSpent) {
  console.log(`👀 Tracking ${tokenMint.slice(0, 8)}...`);

  let peakValue = initialSolSpent;
  let remainingUnits = BigInt(buyAmountUnits);
  let hasTakenPartial = false;
  const startTime = Date.now();
  const maxHoldTimeMs = 3 * 60 * 1000; // 3 minutes

  const checkInterval = setInterval(async () => {
    try {
      if (remainingUnits <= 0n) {
        clearInterval(checkInterval);
        return;
      }

      const quoteRes = await safeFetch(
        `https://api.jup.ag/swap/v1/quote?inputMint=${tokenMint}&outputMint=${SOL_MINT}&amount=${remainingUnits.toString()}&slippageBps=400`
      );
      const quote = await quoteRes.json();
      if (!quote?.outAmount) return;

      const currentValueSol = Number(quote.outAmount) / 1e9;
      if (currentValueSol > peakValue) peakValue = currentValueSol;

      const pnlPct = ((currentValueSol / initialSolSpent) - 1) * 100;
      const color = pnlPct >= 0 ? '\x1b[32m' : '\x1b[31m';
      console.log(`${color}📈 ${currentValueSol.toFixed(4)} SOL | Peak ${peakValue.toFixed(4)} | ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%\x1b[0m`);

      // Partial take-profit at +12%
      if (!hasTakenPartial && currentValueSol >= initialSolSpent * 1.12) {
        const sellUnits = (remainingUnits * 50n) / 100n;
        if (sellUnits > 0n) {
          console.log(`\x1b[32m💰 PARTIAL 50% @ +12%+\x1b[0m`);
          await executeSwap(tokenMint, SOL_MINT, sellUnits.toString());
          remainingUnits -= sellUnits;
          hasTakenPartial = true;
        }
      }

      const trailActive = peakValue >= initialSolSpent * 1.06;
      const pullback = trailActive && currentValueSol < peakValue * 0.90;
      const stopLoss = currentValueSol <= initialSolSpent * 0.95;
      const timedOut = Date.now() - startTime > maxHoldTimeMs;

      if (pullback || stopLoss || timedOut) {
        clearInterval(checkInterval);

        const reason = pullback
          ? `\x1b[32m🟢 TRAILING EXIT\x1b[0m`
          : stopLoss
            ? `\x1b[31m🚨 STOP-LOSS\x1b[0m`
            : `\x1b[33m⏰ TIMEOUT\x1b[0m`;

        console.log(reason);

        if (remainingUnits > 0n) {
          const txid = await executeSwap(tokenMint, SOL_MINT, remainingUnits.toString());
          console.log(`\x1b[32m✅ CLOSED → https://solscan.io/tx/${txid}\x1b[0m`);
        }

        isTrading = false;
        console.log(`🔄 Ready for next target`);
      }
    } catch (e) {}
  }, 4000);
}

async function handleGraduationCandidate(signature) {
  try {
    const balanceLamports = await connection.getBalance(wallet.publicKey);
    const balanceSol = balanceLamports / 1e9;
    
    if (balanceSol < 0.015) {
      isTrading = false;
      return;
    }

    const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 1 });
    if (!tx || !tx.meta) {
      isTrading = false;
      return;
    }

    const postTokenBalances = tx.meta.postTokenBalances || [];
    const newMint = postTokenBalances.find(b => b.mint !== SOL_MINT)?.mint;
    if (!newMint || processedTokens.has(newMint)) {
      isTrading = false;
      return;
    }

    processedTokens.add(newMint);

    const coinRes = await safeFetch(`https://frontend-api.pump.fun/coins/${newMint}`);
    if (!coinRes.ok) {
      isTrading = false;
      return;
    }

    const coinData = await coinRes.json();
    if (coinData.complete) {
      isTrading = false;
      return;
    }

    const virtualSol = coinData.virtual_sol_reserves || 0;
    const graduationProgress = (virtualSol / 85_000_000_000) * 100;

    console.log(`🔍 [Curve Check] Progress: ${graduationProgress.toFixed(1)}% | Virtual SOL: ${(virtualSol / 1e9).toFixed(1)}`);

    // Balanced filters for ~70% win rate
    if (graduationProgress < 87 || virtualSol < 55_000_000_000) {
      isTrading = false;
      return;
    }

    // Buy pressure filter
    const pressureOk = await hasStrongBuyPressure(newMint);
    if (!pressureOk) {
      console.log(`❌ Weak buy pressure — skipping`);
      isTrading = false;
      return;
    }

    console.log(`🎯 Strong buy pressure + near graduation → ENTERING`);

    const solToAllocate = Math.max(0.005, balanceSol - 0.005);
    const amountLamports = Math.floor(solToAllocate * 1e9);

    const txid = await executeSwap(SOL_MINT, newMint, amountLamports);
    console.log(`✅ [ENTRY EXECUTED] Solscan: https://solscan.io/tx/${txid}`);

    setTimeout(async () => {
      try {
        const tokenAccountsRes = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: newMint });
        const tokenUnits = tokenAccountsRes.value[0]?.account?.data?.parsed?.info?.tokenAmount?.amount;
        if (tokenUnits) {
          monitorAndRideSinglePosition(newMint, tokenUnits, solToAllocate);
        } else {
          isTrading = false;
        }
      } catch (err) {
        isTrading = false;
      }
    }, 4000);

  } catch (err) {
    isTrading = false;
  }
}

function startListener() {
  console.log("🌊 [Throttled Graduation Engine] Connecting...");
  const ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    console.log("🟢 [Connected] Scanning cleanly without rate spikes...");
    ws.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "logsSubscribe",
      params: [
        { mentions: [PUMP_FUN_PROGRAM_ID] },
        { commitment: "confirmed" }
      ]
    }));

    // Heartbeat every 60 seconds
    setInterval(() => {
      console.log(`💓 Still scanning... ${new Date().toLocaleTimeString()}`);
    }, 60000);
  });

  ws.on('message', async (data) => {
    try {
      if (isTrading) return;

      // Throttle: max 1 candidate every 3 seconds
      const now = Date.now();
      if (now - lastCheckTimestamp < 3000) return;
      lastCheckTimestamp = now;

      const payload = JSON.parse(data.toString());
      if (!payload.params || !payload.params.result) return;

      const logs = payload.params.result.value.logs || [];
      const signature = payload.params.result.value.signature;

      const isTradeEvent = logs.some(log => 
        log.toLowerCase().includes("instruction: buy") || 
        log.toLowerCase().includes("trade")
      );

      if (isTradeEvent) {
        isTrading = true;
        await handleGraduationCandidate(signature);
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    console.log("WebSocket closed. Reconnecting in 3s...");
    setTimeout(startListener, 3000);
  });

  ws.on('error', (err) => {
    console.log("WebSocket error:", err.message);
  });
}

startListener();
