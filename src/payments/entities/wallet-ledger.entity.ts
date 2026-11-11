import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

export enum WalletLedgerType {
  // Money added to the wallet (deposit, dispute refund, unapplied payment)
  CREDIT = 'CREDIT',
  // Money taken from the wallet (funding an escrow)
  DEBIT = 'DEBIT',
  // A card/transfer payment applied directly to an escrow (the wallet balance does not move)
  ESCROW_FUNDING = 'ESCROW_FUNDING',
}

// Append-only record of every money movement that touches a wallet or funds an escrow.
// `reference` is UNIQUE: it is the idempotency key. Processing the same provider event,
// the same dispute refund or the same escrow funding twice hits the unique constraint.
@Entity({ name: 'wallet_ledgers' })
export class WalletLedger {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 128, unique: true })
  reference: string;

  @Index()
  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'decimal', precision: 12, scale: 2 })
  amount: number;

  @Column({ type: 'varchar', length: 32 })
  type: WalletLedgerType;

  @Column({ type: 'varchar', length: 255, nullable: true })
  description: string;

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt: Date;
}
