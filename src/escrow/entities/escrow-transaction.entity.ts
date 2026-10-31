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
  RELEASED = 'RELEASED',
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

  // Platform service fee — deducted from artisan payout
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

  @Column({ nullable: true })
  paystackReference: string;

  // Transfer references — so we know exactly what Paystack paid and when
  @Column({ type: 'varchar', nullable: true })
  tranche1TransferRef: string | null;

  @Column({ type: 'varchar', nullable: true })
  tranche2TransferRef: string | null;

  @Column('text', { array: true, nullable: true })
  proofOfWorkUrls: string[];

  // PIN is stored hashed in future; for now nullable varchar
  @Column({ type: 'varchar', length: 6, nullable: true })
  handshakePin: string | null;

  @Column({ type: 'timestamp', nullable: true })
  handshakeExpiresAt: Date | null;

  // Tracks failed PIN attempts — locks out after MAX_PIN_ATTEMPTS
  @Column({ default: 0 })
  handshakePinAttempts: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
