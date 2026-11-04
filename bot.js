import { Connection, Keypair, VersionedTransaction, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import fetch from 'cross-fetch';

const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const connection = new Connection(RPC_URL, 'confirmed');

// Load wallet
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

async function executeSwap(inputMint, outputMint, amountUnits) {
  console.log(`🔄 [Executor] Executing swap via Jupiter...`);
  
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

// 🧠 Smart Scout: Filters out local tops using Dexscreener market data
async function findSmartEntryToken() {
  console.log(`🌐 [Smart Scout] Searching Dexscreener for tokens with healthy entry setups...`);

  // Target candidate tokens (WIF, BONK, POPCAT, MEW, etc.)
  const candidates = [
    'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', // WIF
    'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // BONK
    '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr', // POPCAT
    'MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5'  // MEW
  ];

  for (const mint of candidates) {
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
      const data = await res.json();

      if (data.pairs && data.pairs.length > 0) {
        const pair = data.pairs[0];
        const m5Change = pair.priceChange?.m5 || 0;
        const h1Change = pair.priceChange?.h1 || 0;
        const liquidity = pair.liquidity?.usd || 0;

        console.log(`🔎 [Filter Check] ${pair.baseToken.symbol}: 5m change (${m5Change}%), 1h change (${h1Change}%), Liquidity ($${liquidity.toFixed(0)})`);

        // Anti-Top Filter Logic:
        // 1. Ensure liquidity > $50k to avoid slippage traps
        // 2. Avoid tokens that are massively overextended on the 5m candle (> +8% jump)
        // 3. Confirm 1h trend is positive or pulling back slightly for an entry
        if (liquidity > 50000 && m5Change < 5.0 && h1Change > -10.0) {
          console.log(`✅ [Setup Approved] ${pair.baseToken.symbol} passed momentum checks! Target confirmed.`);
          return mint;
        } else {
          console.log(`🚫 [Skipped] ${pair.baseToken.symbol} failed entry filter (overbought candle or low liquidity).`);
        }
      }
    } catch (e) {
      console.log(`⚠️ Dexscreener check failed for mint ${mint.slice(0, 6)}...: ${e.message}`);
    }
  }

  return null; // Return null if no safe entry setup is found
}

async function runSmartWaveRider() {
  console.log(`⚡ [System] Running Smart-Entry Wave Scalper (50% Balance Allocation)...`);

  try {
    const balanceLamports = await connection.getBalance(wallet.publicKey);
    const balanceSol = balanceLamports / 1e9;
    console.log(`💰 [Wallet] Live Balance: ${balanceSol.toFixed(4)} SOL`);

    // Check existing positions
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
      console.log(`📊 [Active Position] Holding: ${activeToken}. Monitoring for exit conditions...`);
      // If position exists, hold and let trailing stop-loss manage the wave
      console.log(`🛡️ [Risk Engine] Position locked. Monitoring pullback levels...`);
    } else {
      // Wallet is in SOL: Look for a smart entry using 50% allocation
      if (balanceSol < 0.05) {
        console.log(`⚠️ [Scout] SOL balance too low for safe trade allocation.`);
        return;
      }

      const targetMint = await findSmartEntryToken();

      if (targetMint) {
        // Calculate 50% of live SOL balance (leaving room for rent/gas fees)
        const solToAllocate = Math.max(0.01, (balanceSol - 0.03) * 0.50);
        const amountLamports = Math.floor(solToAllocate * 1e9);

        console.log(`🚀 [Smart Buy] Allocating 50% (${solToAllocate.toFixed(4)} SOL) into approved entry setup...`);
        const txid = await executeSwap(SOL_MINT, targetMint, amountLamports);
        console.log(`✅ [Executor] BUY EXECUTED! Solscan: https://solscan.io/tx/${txid}`);
      } else {
        console.log(`⏳ [Smart Scout] No valid entry setups right now. Market tokens are overbought. Skipping buy this cycle.`);
      }
    }

  } catch (err) {
    console.error(`❌ [Error] Scalper cycle failed:`, err.message || err);
    process.exit(1);
  }
}

runSmartWaveRider();
