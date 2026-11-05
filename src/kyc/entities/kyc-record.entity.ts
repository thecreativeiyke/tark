import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

export enum KycIdType {
  NIN = 'NIN',
  VOTERS_CARD = 'VOTERS_CARD',
  DRIVERS_LICENSE = 'DRIVERS_LICENSE',
  PASSPORT = 'PASSPORT',
}

export enum KycStatus {
  NOT_SUBMITTED = 'NOT_SUBMITTED',
  PENDING_REVIEW = 'PENDING_REVIEW',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  RESUBMITTED = 'RESUBMITTED',
  SUPERSEDED = 'SUPERSEDED',
  EXPIRED = 'EXPIRED',
  ARCHIVED = 'ARCHIVED',
}

export interface TarkTriageResult {
  engineVersion: string;
  status: 'SUCCESS' | 'AMBIGUOUS' | 'FAILED';
  confidenceTier: 'HIGH' | 'MEDIUM' | 'LOW';
  detectedDocumentType?: string;
  nameAlignment: {
    verdict: 'EXACT' | 'INVERTED' | 'PARTIAL' | 'MISMATCH';
    enteredFirst: string;
    enteredMiddle?: string;
    enteredLast: string;
    extractedFirst?: string;
    extractedMiddle?: string;
    extractedLast?: string;
    notes?: string;
  };
  faceMatchScore?: number; // 0.00 to 1.00
  riskFlags: string[];
  triageSummary: string;
  analyzedAt: string;
}

@Entity({ name: 'kyc_records' })
export class KycRecord {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ type: 'enum', enum: KycIdType, default: KycIdType.NIN })
  idType: KycIdType;

  @Index()
  @Column({ type: 'varchar', length: 128 })
  idNumber: string;

  // Exact positional names as printed on the official identity document
  @Column({ type: 'varchar', length: 120 })
  documentFirstName: string;

  @Column({ type: 'varchar', length: 120, nullable: true })
  documentMiddleName: string;

  @Column({ type: 'varchar', length: 120 })
  documentLastName: string;

  // Secure storage paths
  @Column({ type: 'varchar', length: 1024 })
  documentUrl: string;

  @Index()
  @Column({ type: 'varchar', length: 64 })
  documentSha256: string;

  @Column({ type: 'varchar', length: 1024 })
  selfieUrl: string;

  @Index()
  @Column({ type: 'varchar', length: 64 })
  selfieSha256: string;

  @Index()
  @Column({ type: 'enum', enum: KycStatus, default: KycStatus.PENDING_REVIEW })
  status: KycStatus;

  @Column({ type: 'text', nullable: true })
  rejectionReason: string | null;

  @Column({ type: 'uuid', nullable: true })
  reviewedByAdminId: string | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  reviewedAt: Date | null;

  @Column({ type: 'timestamp with time zone', default: () => 'CURRENT_TIMESTAMP' })
  submittedAt: Date;

  @Column({ type: 'timestamp with time zone', nullable: true })
  expiresAt: Date | null;

  // Dynamic White-labeled AI Triage Payload
  @Column({ type: 'jsonb', nullable: true })
  triageResult: TarkTriageResult | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  // Soft delete preserves all historical snapshots under NDPR / financial compliance
  @DeleteDateColumn({ nullable: true })
  deletedAt: Date | null;
}
