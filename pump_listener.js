import WebSocket from 'ws';
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import fetch from 'cross-fetch';

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
  console.log(`🔑 [Wallet] Active Real-Time Sniper: ${wallet.publicKey.toString()}`);
} catch (err) {
  console.error("❌ Private Key Error:", err.message);
  process.exit(1);
}

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

async function handleSnipe(signature) {
  try {
    const balanceLamports = await connection.getBalance(wallet.publicKey);
    const balanceSol = balanceLamports / 1e9;
    
    if (balanceSol < 0.015) {
      console.log(`⚠️ Balance too low (${balanceSol.toFixed(4)} SOL). Minimum required is 0.015 SOL.`);
      return;
    }

    // --- POSITION SIZING ---
    // Configured for 20% allocation of available SOL balance (reserving 0.005 SOL for network fees)
    const ALLOCATION_PERCENTAGE = 0.20; 
    const solToAllocate = Math.max(0.005, (balanceSol - 0.005) * ALLOCATION_PERCENTAGE);

    const amountLamports = Math.floor(solToAllocate * 1e9);

    const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 1 });
    if (!tx || !tx.meta) return;

    // Safety Filter: Check Dev Wallet Allocation
    const postTokenBalances = tx.meta.postTokenBalances || [];
    const devBalance = postTokenBalances[0]?.uiTokenAmount?.uiAmount || 0;

    if (devBalance > 200000000) { // Over 20% total supply bought by dev
      console.log(`🚫 [Safety Filter] Skipped high-risk token (Dev holds >20%).`);
      return;
    }

    const newMint = postTokenBalances.find(b => b.mint !== SOL_MINT)?.mint;
    if (!newMint) return;

    console.log(`🎯 [Target Acquired] Token Mint: ${newMint}`);
    console.log(`🚀 [Snipe Buying] Spending 20% (${solToAllocate.toFixed(4)} SOL)...`);

    const txid = await executeSwap(SOL_MINT, newMint, amountLamports);
    console.log(`✅ [SNIPE EXECUTED!] Solscan: https://solscan.io/tx/${txid}`);

  } catch (err) {
    console.error(`❌ Snipe Execution Error: ${err.message}`);
  } finally {
    isTrading = false;
  }
}

function startListener() {
  console.log("⚡ [Pump.fun Sniper Engine] Connecting to real-time stream...");
  const ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    console.log("🟢 [Connected] Listening for fresh Pump.fun token launches...");
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

  ws.on('message', async (data) => {
    try {
      const payload = JSON.parse(data.toString());
      if (!payload.params || !payload.params.result) return;

      const logs = payload.params.result.value.logs || [];
      const signature = payload.params.result.value.signature;

      if (logs.some(log => log.includes("Instruction: Create")) && !isTrading) {
        isTrading = true;
        console.log(`\n🚨 [NEW LAUNCH DETECTED] Signature: ${signature.slice(0, 8)}...`);
        await handleSnipe(signature);
      }
    } catch (e) {
      console.error("⚠️ Stream error:", e.message);
    }
  });

  ws.on('close', () => {
    console.log("🔴 Stream closed. Reconnecting in 3s...");
    setTimeout(startListener, 3000);
  });

  ws.on('error', (err) => {
    console.error("❌ WebSocket Error:", err.message);
  });
}

startListener();
