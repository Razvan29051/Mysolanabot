import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import fetch from 'cross-fetch';

const connection = new Connection(process.env.RPC_URL, 'confirmed');

let wallet;
try {
  let raw = process.env.BOT_PRIVATE_KEY ? process.env.BOT_PRIVATE_KEY.trim() : "";
  
  // Remove wrapping quotes if any
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1).trim();
  }

  let secretBytes;
  if (raw.startsWith('[')) {
    secretBytes = Uint8Array.from(JSON.parse(raw));
  } else {
    secretBytes = bs58.decode(raw);
  }

  // Handle both 32-byte seeds and 64-byte full secret keys automatically
  if (secretBytes.length === 64) {
    wallet = Keypair.fromSecretKey(secretBytes);
  } else if (secretBytes.length === 32) {
    wallet = Keypair.fromSeed(secretBytes);
  } else {
    throw new Error(`Unexpected secret key length: ${secretBytes.length} bytes. Expected 32 or 64.`);
  }

  console.log(`🔑 Wallet successfully loaded: ${wallet.publicKey.toString()}`);
} catch (err) {
  console.error("❌ CRITICAL WALLET ERROR:", err.message);
  throw err;
}

async function runAutoTrade() {
  const SOL_MINT = 'So11111111111111111111111111111111111111112';
  const WIF_MINT = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm';
  const tradeAmountLamports = 0.02 * 1e9; // 0.02 SOL

  try {
    console.log("Fetching live DEX quote from Jupiter...");
    const quoteRes = await fetch(
      `https://quote-api.jup.ag/v6/quote?inputMint=${SOL_MINT}&outputMint=${WIF_MINT}&amount=${tradeAmountLamports}&slippageBps=100`
    );
    const quote = await quoteRes.json();

    if (quote.error) throw new Error(quote.error);

    const swapRes = await fetch('https://quote-api.jup.ag/v6/swap', {
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
    const { swapTransaction } = await swapRes.json();

    const swapBuf = Buffer.from(swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(swapBuf);
    transaction.sign([wallet]);

    console.log("Broadcasting live trade to Solana Mainnet...");
    const rawTx = transaction.serialize();
    const txid = await connection.sendRawTransaction(rawTx, { skipPreflight: true });

    console.log(`✅ REAL MONEY TRADE COMPLETE!`);
    console.log(`🔗 Track live transaction on Solscan: https://solscan.io/tx/${txid}`);

  } catch (err) {
    console.error("❌ Trade Execution Failed:", err.message || err);
  }
}

runAutoTrade();
