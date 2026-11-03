import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum NotificationType {
  BID_RECEIVED = 'BID_RECEIVED',
  BID_ACCEPTED = 'BID_ACCEPTED',
  SAFE_LOCK_FUNDED = 'SAFE_LOCK_FUNDED',
  TRANCHE1_RELEASED = 'TRANCHE1_RELEASED',
  HANDSHAKE_READY = 'HANDSHAKE_READY',
  PAYOUT_SETTLED = 'PAYOUT_SETTLED',
  DISPUTE_OPENED = 'DISPUTE_OPENED',
  DISPUTE_RESOLVED = 'DISPUTE_RESOLVED',
  SUPPORT_UPDATE = 'SUPPORT_UPDATE',
  SYSTEM_ALERT = 'SYSTEM_ALERT',
}

@Entity({ name: 'notifications' })
export class Notification {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Column({ type: 'text' })
  message: string;

  @Column({
    type: 'enum',
    enum: NotificationType,
    default: NotificationType.SYSTEM_ALERT,
  })
  type: NotificationType;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any> | null;

  @Column({ type: 'boolean', default: false })
  isRead: boolean;

  @Column({ type: 'timestamp with time zone', nullable: true })
  readAt: Date | null;

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamp with time zone' })
  updatedAt: Date;
}
