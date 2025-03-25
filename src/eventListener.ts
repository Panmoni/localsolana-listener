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

// Program setup
const program = new Program(IDL, { connection });

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

  // Event: EscrowCreated
  program.addEventListener("EscrowCreated", async (event: any, slot: number) => {
    console.log("EscrowCreated event detected at slot", slot, event);
    const { objectId, escrowId, tradeId, seller, buyer, amount, sequential, sequentialEscrowAddress } = event;

    try {
      await pool.query(
        `
        INSERT INTO escrows (
          trade_id, escrow_address, seller_address, buyer_address, token_type, amount, status, sequential, sequential_escrow_address, created_at
        )
        VALUES ($1, $2, $3, $4, 'USDC', $5, 'CREATED', $6, $7, NOW())
        ON CONFLICT (escrow_address)
        DO NOTHING
        `,
        [
          tradeId.toString(), // u64 to string for Postgres
          objectId.toBase58(),
          seller.toBase58(),
          buyer.toBase58(),
          amount.toString(), // u64 to string
          sequential,
          sequentialEscrowAddress ? sequentialEscrowAddress.toBase58() : null,
        ]
      );
      console.log(`Inserted escrow ${objectId.toBase58()} for trade ${tradeId}: CREATED`);
    } catch (err) {
      console.error(`Failed to insert escrow for trade ${tradeId}:`, err);
    }
  });

  // Event: FundsDeposited
  program.addEventListener("FundsDeposited", async (event: any, slot: number) => {
    console.log("FundsDeposited event detected at slot", slot, event);
    const { objectId, tradeId, amount } = event;

    try {
      await pool.query(
        `
        UPDATE escrows
        SET status = 'FUNDED',
            deposit_timestamp = NOW(),
            amount = $3,
            updated_at = NOW()
        WHERE escrow_address = $1 AND trade_id = $2
        `,
        [objectId.toBase58(), tradeId.toString(), amount.toString()]
      );
      console.log(`Updated escrow ${objectId.toBase58()} for trade ${tradeId}: FUNDED`);
    } catch (err) {
      console.error(`Failed to update escrow for trade ${tradeId}:`, err);
    }
  });

  // Event: EscrowReleased
  program.addEventListener("EscrowReleased", async (event: any, slot: number) => {
    console.log("EscrowReleased event detected at slot", slot, event);
    const { objectId, tradeId } = event;

    try {
      // Update escrow status
      await pool.query(
        `
        UPDATE escrows
        SET status = 'RELEASED',
            updated_at = NOW()
        WHERE escrow_address = $1 AND trade_id = $2
        `,
        [objectId.toBase58(), tradeId.toString()]
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
        [objectId.toBase58(), tradeId.toString()]
      );
      console.log(`Updated escrow and trade ${tradeId}: RELEASED/COMPLETED`);
    } catch (err) {
      console.error(`Failed to update escrow/trade ${tradeId}:`, err);
    }
  });

  // Event: EscrowCancelled
  program.addEventListener("EscrowCancelled", async (event: any, slot: number) => {
    console.log("EscrowCancelled event detected at slot", slot, event);
    const { objectId, tradeId } = event;

    try {
      await pool.query(
        `
        UPDATE escrows
        SET status = 'CANCELLED',
            updated_at = NOW()
        WHERE escrow_address = $1 AND trade_id = $2
        `,
        [objectId.toBase58(), tradeId.toString()]
      );

      await pool.query(
        `
        UPDATE trades
        SET leg1_state = CASE WHEN leg1_escrow_address = $1 THEN 'CANCELLED' ELSE leg1_state END,
            leg1_cancelled_at = CASE WHEN leg1_escrow_address = $1 THEN NOW() ELSE leg1_cancelled_at END,
            leg2_state = CASE WHEN leg2_escrow_address = $1 THEN 'CANCELLED' ELSE leg2_state END,
            leg2_cancelled_at = CASE WHEN leg2_escrow_address = $1 THEN NOW() ELSE leg2_cancelled_at END,
            overall_status = CASE 
              WHEN (leg1_escrow_address = $1 AND leg2_escrow_address IS NULL) OR 
                   (leg1_escrow_address = $1 AND leg2_state IN ('COMPLETED', 'CANCELLED')) OR 
                   (leg2_escrow_address = $1 AND leg1_state IN ('COMPLETED', 'CANCELLED'))
              THEN 'CANCELLED'
              ELSE overall_status 
            END
        WHERE id = $2
        `,
        [objectId.toBase58(), tradeId.toString()]
      );
      console.log(`Updated escrow and trade ${tradeId}: CANCELLED`);
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