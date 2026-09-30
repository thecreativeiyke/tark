import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
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

  @Column({ type: 'varchar', length: 6, nullable: true })
  handshakePin: string | null;

  @Column({ type: 'timestamp', nullable: true })
  handshakeExpiresAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
