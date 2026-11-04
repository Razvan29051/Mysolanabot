import { Connection, Keypair, VersionedTransaction, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import fetch from 'cross-fetch';

const connection = new Connection(process.env.RPC_URL, 'confirmed');

let wallet;
try {
  let raw = process.env.BOT_PRIVATE_KEY ? process.env.BOT_PRIVATE_KEY.trim() : "";
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1).trim();
  }
  wallet = Keypair.fromSecretKey(raw.startsWith('[') ? Uint8Array.from(JSON.parse(raw)) : bs58.decode(raw));
} catch (err) {
  throw new Error("Key Load Error: " + err.message);
}

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const TARGET_TOKEN_MINT = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm'; // WIF
const TRAILING_DROP_PCT = 0.08; // Sell if price drops 8% from its peak

async function executeSwap(inputMint, outputMint, amountLamports) {
  const quoteRes = await fetch(
    `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=150`
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
  const transaction = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
  transaction.sign([wallet]);

  const txid = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true });
  return txid;
}

async function runTrailingBot() {
  try {
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
      programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
    });

    let tokenBalance = 0;
    let tokenAccountData = null;

    for (const acc of tokenAccounts.value) {
      const parsedInfo = acc.account.data.parsed.info;
      if (parsedInfo.mint === TARGET_TOKEN_MINT) {
        tokenBalance = parsedInfo.tokenAmount.uiAmount || 0;
        tokenAccountData = parsedInfo.tokenAmount;
        break;
      }
    }

    if (tokenBalance > 0) {
      // Get current SOL value for held tokens
      const quoteRes = await fetch(
        `https://quote-api.jup.ag/v6/quote?inputMint=${TARGET_TOKEN_MINT}&outputMint=${SOL_MINT}&amount=${tokenAccountData.amount}&slippageBps=150`
      );
      const quote = await quoteRes.json();
      const currentSolVal = quote.outAmount / 1e9;
      
      console.log(`📈 Token Held | Current Value: ${currentSolVal} SOL`);
      
      // To implement a strict trailing peak on GitHub Actions (stateless environment), 
      // you can track your peak using a lightweight state or let the bot evaluate drop limits.
      // If you want to dump immediately on an 8% dip from a target, the logic executes here:
      
      // Example condition placeholder for trailing sell:
      // if (currentSolVal <= peakValue * (1 - TRAILING_DROP_PCT)) { ... }
      
    } else {
      console.log("🔍 No tokens found. Buying initial bag (0.02 SOL)...");
      const txid = await executeSwap(SOL_MINT, TARGET_TOKEN_MINT, Math.floor(0.02 * 1e9));
      console.log(`✅ BUY EXECUTED! Solscan: https://solscan.io/tx/${txid}`);
    }
  } catch (err) {
    console.error("❌ Error in bot loop:", err.message);
  }
}

runTrailingBot();
