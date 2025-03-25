import { Connection, PublicKey } from "@solana/web3.js";
import { Program } from "@coral-xyz/anchor";
import { Pool } from "pg";
import * as dotenv from "dotenv";

// Load IDL from src/idl
import IDL from "./idl/localsolana_contracts.json";

// Load environment variables
dotenv.config();

// Solana setup
const SOLANA_RPC = process.env.SOLANA_RPC || "https://api.devnet.solana.com";
const SOLANA_WS = process.env.SOLANA_WS || "wss://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID || "4PonUp1nPEzDPnRMPjTqufLT3f37QuBJGk1CVnsTXx7x");

const connection = new Connection(SOLANA_RPC!, {
  wsEndpoint: SOLANA_WS!,
  commitment: "confirmed",
});

// Program setup (matching your API)
export const program = new Program(IDL, { connection });

// Postgres setup
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Event listener logic
async function startEventListener() {
  console.log(`Starting event listener for program ${PROGRAM_ID.toBase58()} on ${SOLANA_RPC}`);

  // Test Postgres connection
  try {
    await pool.query("SELECT NOW()");
    console.log("Connected to Postgres");
  } catch (err) {
    console.error("Failed to connect to Postgres:", err);
    process.exit(1);
  }

  // Event: FundsDeposited (escrow funded)
  program.addEventListener("FundsDeposited", async (event: any, slot: number) => {
    console.log("FundsDeposited event detected at slot", slot, event);
    const { escrowAccount, tradeId, amount, sellerAddress, buyerAddress } = event;

    try {
      await pool.query(
        `
        INSERT INTO escrows (
          trade_id, escrow_address, seller_address, buyer_address, token_type, amount, status, deposit_timestamp, sequential
        )
        VALUES ($1, $2, $3, $4, 'USDC', $5, 'FUNDED', NOW(), false)
        ON CONFLICT (escrow_address)
        DO UPDATE SET
          status = 'FUNDED',
          deposit_timestamp = NOW(),
          amount = EXCLUDED.amount,
          updated_at = NOW()
        `,
        [tradeId, escrowAccount.toBase58(), sellerAddress.toBase58(), buyerAddress.toBase58(), amount]
      );
      console.log(`Updated escrow ${escrowAccount.toBase58()} for trade ${tradeId}: FUNDED`);
    } catch (err) {
      console.error(`Failed to update escrow for trade ${tradeId}:`, err);
    }
  });

  // Event: FundsReleased (escrow released)
  program.addEventListener("FundsReleased", async (event: any, slot: number) => {
    console.log("FundsReleased event detected at slot", slot, event);
    const { escrowAccount, tradeId } = event;

    try {
      // Update escrow status
      await pool.query(
        `
        UPDATE escrows
        SET status = 'RELEASED',
            updated_at = NOW()
        WHERE escrow_address = $1 AND trade_id = $2
        `,
        [escrowAccount.toBase58(), tradeId]
      );

      // Update trade leg1 or leg2 based on escrow_address match
      await pool.query(
        `
        UPDATE trades
        SET leg1_state = CASE WHEN leg1_escrow_address = $1 THEN 'COMPLETED' ELSE leg1_state END,
            leg1_released_at = CASE WHEN leg1_escrow_address = $1 THEN NOW() ELSE leg1_released_at END,
            leg2_state = CASE WHEN leg2_escrow_address = $1 THEN 'COMPLETED' ELSE leg2_state END,
            leg2_released_at = CASE WHEN leg2_escrow_address = $1 THEN NOW() ELSE leg2_released_at END,
            overall_status = CASE 
              WHEN (leg1_escrow_address = $1 AND leg2_escrow_address IS NULL) OR 
                   (leg1_escrow_address = $1 AND leg2_state = 'COMPLETED') OR 
                   (leg2_escrow_address = $1 AND leg1_state = 'COMPLETED')
              THEN 'COMPLETED'
              ELSE overall_status 
            END
        WHERE id = $2
        `,
        [escrowAccount.toBase58(), tradeId]
      );
      console.log(`Updated escrow and trade ${tradeId}: RELEASED/COMPLETED`);
    } catch (err) {
      console.error(`Failed to update escrow/trade ${tradeId}:`, err);
    }
  });

  // Graceful shutdown
  process.on("SIGINT", async () => {
    console.log("Shutting down event listener...");
    await pool.end();
    process.exit(0);
  });
}

// Start the listener
startEventListener().catch((err) => {
  console.error("Event listener failed:", err);
  process.exit(1);
});