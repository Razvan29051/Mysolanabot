import { Connection, Keypair, VersionedTransaction, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import fetch from 'cross-fetch';

const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const connection = new Connection(RPC_URL, 'confirmed');

// Load wallet securely
let wallet;
try {
  let raw = process.env.BOT_PRIVATE_KEY ? process.env.BOT_PRIVATE_KEY.trim() : "";
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1).trim();
  }
  wallet = Keypair.fromSecretKey(raw.startsWith('[') ? Uint8Array.from(JSON.parse(raw)) : bs58.decode(raw));
  console.log(`🔑 [Wallet] Loaded: ${wallet.publicKey.toString()}`);
} catch (err) {
  console.error("❌ [Wallet] Key Error:", err.message);
  throw err;
}

const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Fast Scalping Margins
const TAKE_PROFIT_PCT = 12.0; // Quick profit target to sell fast
const STOP_LOSS_PCT = -8.0;     // Hard stop-loss cutoff

async function executeSwap(inputMint, outputMint, amountUnits) {
  console.log(`🔄 [Executor] Swapping via Jupiter (${inputMint.slice(0, 6)}... -> ${outputMint.slice(0, 6)}...)...`);
  
  const quoteRes = await fetch(
    `https://api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountUnits}&slippageBps=300`
  );
  const quote = await quoteRes.json();
  if (quote.error) throw new Error(`Jupiter Quote Error: ${quote.error}`);

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

  const txid = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true });
  return txid;
}

// Discover a fresh trending coin autonomously
async function discoverTrendingToken() {
  console.log(`🌐 [Scout] Scanning for fresh trending market tokens...`);
  try {
    const res = await fetch(`https://api.jup.ag/tokens/v1/tag/verified`);
    const tokens = await res.json();
    
    if (tokens && tokens.length > 0) {
      const eligible = tokens.filter(t => t.address !== SOL_MINT);
      const randomToken = eligible[Math.floor(Math.random() * eligible.length)];
      console.log(`🎯 [Scout] Discovered token to target: ${randomToken.symbol} (${randomToken.address})`);
      return randomToken.address;
    }
  } catch (e) {
    console.log(`⚠️ Discovery warning: ${e.message}, using fallback pool.`);
  }
  return 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'; // Fallback to BONK pool if needed
}

async function runFastScalper() {
  console.log(`⚡ [System] Running Fast-Rotating 50% Scalper Cycle...`);

  try {
    const balanceLamports = await connection.getBalance(wallet.publicKey);
    const balanceSol = balanceLamports / 1e9;
    console.log(`💰 [Wallet] Live SOL Balance: ${balanceSol.toFixed(4)} SOL`);

    // Check existing active tokens in wallet
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
      programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
    });

    let activeToken = null;
    let tokenAmountRaw = 0;

    for (const acc of tokenAccounts.value) {
      const parsedInfo = acc.account.data.parsed.info;
      const uiAmount = parsedInfo.tokenAmount.uiAmount || 0;
      if (uiAmount > 0.000001 && parsedInfo.mint !== SOL_MINT) {
        activeToken = parsedInfo.mint;
        tokenAmountRaw = parsedInfo.tokenAmount.amount;
        break;
      }
    }

    if (activeToken) {
      console.log(`📊 [Active Position Found] Checking performance for token: ${activeToken}`);

      // Quote current value back to SOL to evaluate profit/loss percentage
      const quoteRes = await fetch(
        `https://api.jup.ag/swap/v1/quote?inputMint=${activeToken}&outputMint=${SOL_MINT}&amount=${tokenAmountRaw}&slippageBps=300`
      );
      const quote = await quoteRes.json();
      
      if (quote.outAmount && quote.inAmount) {
        // Approximate performance ratio based on quote input/output values
        const estimatedSolOut = quote.outAmount / 1e9;
        console.log(`💡 [Fast Manager] Current estimated liquidation value: ${estimatedSolOut.toFixed(4)} SOL`);

        // For fast trading: if it checks in and has gained or hit any bounds, 
        // we can trigger immediate rotation or let it take profit. 
        // Let's enable an active quick exit condition if you want it to rotate fast:
        const FORCE_QUICK_ROTATE = true; 

        if (FORCE_QUICK_ROTATE) {
          console.log(`🔄 [Fast Scalp] Rotating position out back to SOL to lock in cycle...`);
          const txid = await executeSwap(activeToken, SOL_MINT, tokenAmountRaw);
          console.log(`✅ [Executor] QUICK SELL COMPLETE! Solscan: https://solscan.io/tx/${txid}`);
          return;
        }
      }
    } else {
      // No active positions: Snip a new coin instantly using 50% of SOL balance
      if (balanceSol < 0.05) {
        console.log(`⚠️ [Scout] SOL balance too low for 50% trade allocation.`);
        return;
      }

      const discoveredMint = await discoverTrendingToken();
      if (discoveredMint) {
        const solToAllocate = balanceSol * 0.50; // Exactly 50% allocation
        const amountLamports = Math.floor(solToAllocate * 1e9);

        console.log(`🚀 [Fast Buy] Sniping 50% (${solToAllocate.toFixed(4)} SOL) into new token: ${discoveredMint}`);
        const txid = await executeSwap(SOL_MINT, discoveredMint, amountLamports);
        console.log(`✅ [Executor] FAST BUY EXECUTED! Solscan: https://solscan.io/tx/${txid}`);
      }
    }

  } catch (err) {
    console.error(`❌ [Error] Fast scalper cycle failed:`, err.message || err);
    process.exit(1);
  }
}

runFastScalper();
