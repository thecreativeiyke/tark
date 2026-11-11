import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum EscrowStatus {
  INITIATED = 'INITIATED',
  FUNDS_LOCKED = 'FUNDS_LOCKED',
  TRANCHE_1_RELEASED = 'TRANCHE_1_RELEASED',
  HANDSHAKE_PENDING = 'HANDSHAKE_PENDING',
  SETTLED = 'SETTLED',
  DISPUTED = 'DISPUTED',
}

export enum TrancheStatus {
  PENDING = 'PENDING',
  LOCKED = 'LOCKED',
  PAYOUT_PENDING = 'PAYOUT_PENDING',
  RELEASED = 'RELEASED',
  PAYOUT_FAILED = 'PAYOUT_FAILED',
  REFUNDED = 'REFUNDED',
}

@Entity()
export class EscrowTransaction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // One escrow per job — enforced at DB level too
  @Index({ unique: true })
  @Column()
  jobId: string;

  @Column()
  clientId: string;

  @Column({ nullable: true })
  artisanId: string;

  @Column({ default: 'NGN' })
  currency: string;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  tranche1Amount: number;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  tranche2Amount: number;

  // Platform service fee — deducted from the artisan's final payout
  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  platformFeeAmount: number;

  @Column({
    type: 'enum',
    enum: TrancheStatus,
    default: TrancheStatus.PENDING,
  })
  tranche1Status: TrancheStatus;

  @Column({
    type: 'enum',
    enum: TrancheStatus,
    default: TrancheStatus.PENDING,
  })
  tranche2Status: TrancheStatus;

  @Column({
    type: 'enum',
    enum: EscrowStatus,
    default: EscrowStatus.INITIATED,
  })
  totalStatus: EscrowStatus;

  // Looked up on every payment webhook, so it must be indexed.
  @Index()
  @Column({ nullable: true })
  paystackReference: string;

  // Transfer references — so we know exactly what Paystack paid and when
  @Column({ type: 'varchar', nullable: true })
  tranche1TransferRef: string | null;

  @Column({ type: 'varchar', nullable: true })
  tranche2TransferRef: string | null;

  // Which channel funded the escrow ('WALLET' | 'ONLINE'). A later online payment on a
  // wallet-funded escrow is a duplicate and gets credited back to the client's wallet.
  @Column({ type: 'varchar', length: 16, nullable: true })
  fundedVia: string | null;

  // The exact payment reference that funded the escrow online. paystackReference only holds the
  // LAST checkout started (Pay-For-Me re-initialises it), so replay detection must use this one.
  @Column({ type: 'varchar', nullable: true })
  fundedReference: string | null;

  // Platform fee actually retained at settlement, in kobo
  @Column({ type: 'integer', default: 0 })
  feeCollectedMinor: number;

  @Column('text', { array: true, nullable: true })
  proofOfWorkUrls: string[];

  // PIN is stored hashed in future; for now nullable varchar
  @Column({ type: 'varchar', length: 6, nullable: true })
  handshakePin: string | null;

  @Column({ type: 'timestamp', nullable: true })
  handshakeExpiresAt: Date | null;

  // Tracks failed PIN attempts for the CURRENT pin — resets when a new pin is issued
  @Column({ default: 0 })
  handshakePinAttempts: number;

  // Number of brute-force lockouts (5 wrong PINs) on this escrow. Expiry does NOT count.
  @Column({ default: 0 })
  handshakeCycles: number;

  // While in the future, a new handshake cannot be started (exponential cooldown, capped at 24h)
  @Column({ type: 'timestamptz', nullable: true })
  handshakeLockedUntil: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
