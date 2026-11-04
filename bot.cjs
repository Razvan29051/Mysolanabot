const { Connection, Keypair, VersionedTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');
const fetch = require('cross-fetch');

const connection = new Connection(process.env.RPC_URL, 'confirmed');
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.BOT_PRIVATE_KEY));

async function runAutoTrade() {
  console.log(`🤖 Bot Active | Executing for Wallet: ${wallet.publicKey.toString()}`);

  const SOL_MINT = 'So11111111111111111111111111111111111111112';
  const WIF_MINT = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm';
  const tradeAmountLamports = 0.02 * 1e9; // 0.02 SOL

  try {
    console.log("Fetching live DEX quote...");
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
