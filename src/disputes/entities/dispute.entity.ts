import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum DisputeCategory {
  ABANDONED_JOB = 'ABANDONED_JOB',
  POOR_QUALITY_OR_INCOMPLETE = 'POOR_QUALITY_OR_INCOMPLETE',
  DAMAGE_TO_PROPERTY = 'DAMAGE_TO_PROPERTY',
  CLIENT_WITHHOLDING_PIN = 'CLIENT_WITHHOLDING_PIN',
  PAYMENT_OR_PRICE_DISAGREEMENT = 'PAYMENT_OR_PRICE_DISAGREEMENT',
  SAFETY_OR_CONDUCT = 'SAFETY_OR_CONDUCT',
  OTHER = 'OTHER',
}

export enum DisputeStatus {
  OPEN = 'OPEN', // Filed, awaiting defendant counter-claim (48h window)
  AWAITING_REVIEW = 'AWAITING_REVIEW', // Counter submitted or 48h elapsed; in triage queue
  UNDER_INVESTIGATION = 'UNDER_INVESTIGATION', // Active review by designated admin/specialist
  RESOLVED = 'RESOLVED', // Verdict rendered and financial settlement executed
  DISMISSED = 'DISMISSED', // Voluntarily withdrawn or dismissed
}

export enum DisputeVerdict {
  FULL_REFUND_TO_CLIENT = 'FULL_REFUND_TO_CLIENT',
  FULL_PAYOUT_TO_ARTISAN = 'FULL_PAYOUT_TO_ARTISAN',
  SPLIT_SETTLEMENT = 'SPLIT_SETTLEMENT',
  MUTUAL_CANCELLATION = 'MUTUAL_CANCELLATION',
}

@Entity()
export class Dispute {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column()
  jobId: string;

  @Index()
  @Column()
  escrowId: string;

  // The party who opened the ticket (client or artisan)
  @Column()
  initiatorId: string;

  // The opposing party
  @Column()
  defendantId: string;

  @Column({
    type: 'enum',
    enum: DisputeCategory,
    default: DisputeCategory.OTHER,
  })
  category: DisputeCategory;

  @Column({ type: 'text' })
  claimStatement: string;

  @Column('text', { array: true, default: '{}' })
  evidenceUrls: string[];

  // Opposing party counter-statement
  @Column({ type: 'text', nullable: true })
  counterStatement: string | null;

  @Column('text', { array: true, default: '{}' })
  counterEvidenceUrls: string[];

  // 48-hour response window for defendant to submit their side
  @Column({ type: 'timestamp' })
  responseDeadline: Date;

  @Column({
    type: 'enum',
    enum: DisputeStatus,
    default: DisputeStatus.OPEN,
  })
  status: DisputeStatus;

  // Support / Admin tier routing
  @Column({ type: 'varchar', nullable: true })
  assignedAdminId: string | null;

  @Column({ default: 'DISPUTE_DESK' })
  adminDepartment: string; // 'GENERAL_SUPPORT', 'DISPUTE_DESK', 'FRAUD_INVESTIGATION', 'EXECUTIVE'

  // Final resolution verdict
  @Column({
    type: 'enum',
    enum: DisputeVerdict,
    nullable: true,
  })
  verdict: DisputeVerdict | null;

  // Exact financial disbursement breakdown (Platform service fee is retained/non-refundable)
  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  clientRefundAmount: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  artisanPayoutAmount: number;

  @Column({ type: 'text', nullable: true })
  resolutionNotes: string | null;

  @Column({ type: 'timestamp', nullable: true })
  resolvedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
