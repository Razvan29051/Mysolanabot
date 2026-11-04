import WebSocket from 'ws';
import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
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
  console.log(`🔑 [Wallet] Multi-Agent Wave Sniper Active: ${wallet.publicKey.toString()}`);
} catch (err) {
  console.error("❌ Private Key Error:", err.message);
  process.exit(1);
}

// Single-position lock flag
let isTrading = false;

async function executeSwap(inputMint, outputMint, amountUnits) {
  const quoteRes = await fetch(
    `https://api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountUnits}&slippageBps=500`
  );
  const quote = await quoteRes.json();
  if (quote.error) throw new Error(`Quote Error: ${quote.error}`);

  const swapRes = await fetch('https://api.jup.ag/swap/v1/swap', {
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

// AGENT 1: Holder Supply Concentration Filter (On-Chain RPC)
async function checkHolderDistribution(tokenMint) {
  try {
    const mintPublicKey = new PublicKey(tokenMint);
    const largestAccounts = await connection.getTokenLargestAccounts(mintPublicKey);
    
    if (!largestAccounts || !largestAccounts.value || largestAccounts.value.length === 0) {
      return false;
    }

    const totalSupply = 1_000_000_000 * 1e6; // Standard Pump.fun supply (1 Billion tokens)
    const accounts = largestAccounts.value;

    // Skip index 0 as it usually represents the Pump.fun bonding curve vault
    let insiderTokensHeld = 0;
    for (let i = 1; i < Math.min(accounts.length, 6); i++) {
      insiderTokensHeld += parseInt(accounts[i].amount || 0);
    }

    const insiderSharePercent = (insiderTokensHeld / totalSupply) * 100;
    console.log(`🔍 [Agent 1: Distribution] Top 5 Holders Own: ${insiderSharePercent.toFixed(2)}% of supply`);

    // Reject if top 5 non-bonding-curve wallets hold more than 25% of total supply
    if (insiderSharePercent > 25) {
      console.log(`🚫 [Agent 1 Skipped] Supply concentrated in too few wallets (${insiderSharePercent.toFixed(1)}%).`);
      return false;
    }

    return true;
  } catch (err) {
    // If holder RPC call fails, continue safely
    return true;
  }
}

// AGENT 2: Metadata & Community Sentiment Check
async function checkTokenMetadata(tokenMint) {
  try {
    const coinRes = await fetch(`https://frontend-api.pump.fun/coins/${tokenMint}`);
    if (!coinRes.ok) return false;

    const coinData = await coinRes.json();
    const hasTwitter = coinData.twitter && coinData.twitter.trim().length > 0;
    const hasTelegram = coinData.telegram && coinData.telegram.trim().length > 0;
    const hasDescription = coinData.description && coinData.description.length > 5;

    console.log(`🎨 [Agent 2: Metadata] Has Socials: ${hasTwitter || hasTelegram} | Description: ${hasDescription}`);

    if (!hasDescription || (!hasTwitter && !hasTelegram)) {
      console.log(`🚫 [Agent 2 Skipped] Missing basic social links or narrative metadata.`);
      return false;
    }

    return true;
  } catch (err) {
    return false;
  }
}

// Single Position Manager: Rides green wave with trailing exit lock
async function monitorAndRideSinglePosition(tokenMint, buyAmountUnits, initialSolSpent) {
  console.log(`👀 [Position Manager] Tracking wave for ${tokenMint.slice(0, 8)}...`);
  
  let peakValue = initialSolSpent;
  const startTime = Date.now();
  const maxHoldTimeMs = 4 * 60 * 1000;

  const checkInterval = setInterval(async () => {
    try {
      const quoteRes = await fetch(
        `https://api.jup.ag/swap/v1/quote?inputMint=${tokenMint}&outputMint=${SOL_MINT}&amount=${buyAmountUnits}&slippageBps=500`
      );
      const quote = await quoteRes.json();
      if (!quote || quote.error) return;

      const currentValueSol = parseInt(quote.outAmount) / 1e9;
      
      if (currentValueSol > peakValue) {
        peakValue = currentValueSol;
      }

      console.log(`📈 [Position Track] Current: ${currentValueSol.toFixed(4)} SOL | Peak: ${peakValue.toFixed(4)} SOL`);

      const pulledBackFromPeak = peakValue > (initialSolSpent * 1.02) && currentValueSol < peakValue * 0.90;
      const hitStopLoss = currentValueSol <= initialSolSpent * 0.92;
      const timedOut = Date.now() - startTime > maxHoldTimeMs;

      if (pulledBackFromPeak || hitStopLoss || timedOut) {
        clearInterval(checkInterval);
        console.log(pulledBackFromPeak ? `🟢 [Profit Secured] Selling on peak pullback...` : `🚨 [Stop-Loss/Timeout] Closing position...`);
        
        const sellTxid = await executeSwap(tokenMint, SOL_MINT, buyAmountUnits);
        console.log(`✅ [POSITION CLOSED] Solscan: https://solscan.io/tx/${sellTxid}`);
        
        isTrading = false;
        console.log(`🔄 [Status] Wallet unlocked for next clean setup.`);
      }
    } catch (e) {}
  }, 4000);
}

async function handleSnipe(signature) {
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
    if (!newMint) {
      isTrading = false;
      return;
    }

    console.log(`⚡ [New Token Detected] Address: ${newMint}`);

    // Run Agent 2 (Metadata & Sentiment)
    const metadataOk = await checkTokenMetadata(newMint);
    if (!metadataOk) {
      isTrading = false;
      return;
    }

    // Run Agent 1 (Supply Concentration Check)
    const distributionOk = await checkHolderDistribution(newMint);
    if (!distributionOk) {
      isTrading = false;
      return;
    }

    // Agent 3: 10-Second Volume Acceleration Check
    console.log(`⏳ [Agent 3: Volume Engine] Sampling 10s velocity on ${newMint.slice(0, 8)}...`);
    let solAtT0 = 0;
    try {
      const res0 = await fetch(`https://frontend-api.pump.fun/coins/${newMint}`);
      if (res0.ok) solAtT0 = (await res0.json()).virtual_sol_reserves || 0;
    } catch (e) {}

    await new Promise(resolve => setTimeout(resolve, 10000));

    let solAtT10 = solAtT0;
    try {
      const res10 = await fetch(`https://frontend-api.pump.fun/coins/${newMint}`);
      if (res10.ok) {
        const data10 = await res10.json();
        if (data10.complete) {
          isTrading = false;
          return;
        }
        solAtT10 = data10.virtual_sol_reserves || 0;
      }
    } catch (e) {}

    const growthSol = (solAtT10 - solAtT0) / 1e9;
    console.log(`📊 [Volume Stats] Net Growth: +${growthSol.toFixed(2)} SOL`);

    if (growthSol < 0.3) {
      console.log(`🚫 [Agent 3 Skipped] Low volume growth (+${growthSol.toFixed(2)} SOL).`);
      isTrading = false;
      return;
    }

    // Execution: Single-shot full wallet allocation
    const solToAllocate = Math.max(0.005, balanceSol - 0.005);
    const amountLamports = Math.floor(solToAllocate * 1e9);

    console.log(`🎯 [ALL AGENT CHECKS PASSED] Deploying ${solToAllocate.toFixed(4)} SOL into ${newMint.slice(0, 8)}...`);

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
  console.log("🌊 [Multi-Agent Wave Engine] Connecting...");
  const ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    console.log("🟢 [Connected] Listening for live creation events...");
    ws.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "logsSubscribe",
      params: [
        { mentions: [PUMP_FUN_PROGRAM_ID] },
        { commitment: "confirmed" }
      ]
    }));
  });

  ws.on('message', async (data) => {
    try {
      if (isTrading) return;

      const payload = JSON.parse(data.toString());
      if (!payload.params || !payload.params.result) return;

      const logs = payload.params.result.value.logs || [];
      const signature = payload.params.result.value.signature;

      const isCreateEvent = logs.some(log => 
        log.toLowerCase().includes("instruction: create") || 
        log.toLowerCase().includes("initialize") ||
        log.toLowerCase().includes("create")
      );

      if (isCreateEvent) {
        isTrading = true;
        await handleSnipe(signature);
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    setTimeout(startListener, 3000);
  });

  ws.on('error', (err) => {});
}

startListener();
