import { Connection, Keypair, VersionedTransaction, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import fetch from 'cross-fetch';

const connection = new Connection(process.env.RPC_URL || "https://api.mainnet-beta.solana.com", 'confirmed');

// Load wallet securely
let wallet;
try {
  let raw = process.env.BOT_PRIVATE_KEY ? process.env.BOT_PRIVATE_KEY.trim() : "";
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1).trim();
  }
  wallet = Keypair.fromSecretKey(raw.startsWith('[') ? Uint8Array.from(JSON.parse(raw)) : bs58.decode(raw));
  console.log(`🔑 [Wallet] Loaded successfully: ${wallet.publicKey.toString()}`);
} catch (err) {
  console.error("❌ [Wallet] Critical Error loading private key:", err.message);
  throw err;
}

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const DEFAULT_TARGET_MINT = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm'; // WIF
const TRADE_ALLOC_SOL = 0.02; // Amount of SOL to spend on a buy

async function executeSwap(inputMint, outputMint, amountUnits) {
  console.log(`🔄 [Executor] Requesting Jupiter quote (${inputMint} -> ${outputMint})...`);
  
  const quoteRes = await fetch(
    `https://api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountUnits}&slippageBps=200`
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
  if (!swapData.swapTransaction) throw new Error("Failed to generate swap transaction from Jupiter.");

  const transaction = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, 'base64'));
  transaction.sign([wallet]);

  const txid = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true });
  return txid;
}

async function runScalperCycle() {
  console.log(`⚡ [System] Starting Multi-X Scalper Cycle...`);

  try {
    const balanceLamports = await connection.getBalance(wallet.publicKey);
    const balanceSol = balanceLamports / 1e9;
    console.log(`💰 [Wallet] Live Balance: ${balanceSol.toFixed(4)} SOL`);

    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
      programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
    });

    let activeTokenAccount = null;
    let tokenBalance = 0;
    let tokenMint = DEFAULT_TARGET_MINT;
    let tokenAmountRaw = 0;

    for (const acc of tokenAccounts.value) {
      const parsedInfo = acc.account.data.parsed.info;
      const uiAmount = parsedInfo.tokenAmount.uiAmount || 0;
      if (uiAmount > 0.000001 && parsedInfo.mint !== SOL_MINT) {
        tokenBalance = uiAmount;
        tokenMint = parsedInfo.mint;
        tokenAmountRaw = parsedInfo.tokenAmount.amount;
        activeTokenAccount = acc.pubkey;
        break;
      }
    }

    if (activeTokenAccount) {
      console.log(`📊 [Position Active] Found token holding: ${tokenMint} (Balance: ${tokenBalance})`);

      // Check current value in SOL via Jupiter Quote
      const quoteRes = await fetch(
        `https://api.jup.ag/swap/v1/quote?inputMint=${tokenMint}&outputMint=${SOL_MINT}&amount=${tokenAmountRaw}&slippageBps=200`
      );
      const quote = await quoteRes.json();
      
      if (quote.outAmount) {
        const currentSolVal = quote.outAmount / 1e9;
        console.log(`💡 [Analyst] Current estimated liquidation value: ${currentSolVal.toFixed(4)} SOL`);
        
        // AUTOMATIC EXIT CONDITION: 
        // For demonstration, if you want it to sell back to SOL right now when testing, 
        // or you can set a rule (e.g. target profit or stop-loss trigger).
        // To force a sell on this run, set FORCE_SELL to true. If false, it holds and monitors:
        const FORCE_SELL = false; 

        if (FORCE_SELL) {
          console.log(`🚨 [Risk Engine] Exit condition met! Selling token back to SOL...`);
          const txid = await executeSwap(tokenMint, SOL_MINT, tokenAmountRaw);
          console.log(`✅ [Executor] SELL COMPLETE! Solscan: https://solscan.io/tx/${txid}`);
          return;
        }
      }
      console.log(`🛡️ [Risk Engine] Holding position... tracking market waves.`);

    } else {
      if (balanceSol < TRADE_ALLOC_SOL + 0.005) {
        console.log(`⚠️ [Scout] Balance too low to open a new position safely.`);
        return;
      }

      console.log(`🎯 [Scout] No tokens held. Executing buy order...`);
      const buyAmountLamports = Math.floor(TRADE_ALLOC_SOL * 1e9);
      const txid = await executeSwap(SOL_MINT, DEFAULT_TARGET_MINT, buyAmountLamports);
      
      console.log(`✅ [Executor] BUY COMPLETE!`);
      console.log(`🔗 Track transaction on Solscan: https://solscan.io/tx/${txid}`);
    }

  } catch (err) {
    console.error(`❌ [Error] Scalper cycle failed:`, err.message || err);
    process.exit(1);
  }
}

runScalperCycle();
