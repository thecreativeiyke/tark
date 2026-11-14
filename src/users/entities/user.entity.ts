import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum UserRole {
  CLIENT = 'client',
  ARTISAN = 'artisan',
  ADMIN = 'admin',
  SUPER_ADMIN = 'super_admin',
  DEVELOPER = 'developer',
}

@Entity()
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  email: string;

  @Column({ select: false })
  password: string;

  @Column()
  fullName: string;

  @Column({ nullable: true })
  firstName: string;

  @Column({ nullable: true })
  middleName: string;

  @Column({ nullable: true })
  lastName: string;

  @Column({ nullable: true })
  phoneNumber: string;

  @Column({ default: false })
  phoneVerified: boolean;

  @Column({ nullable: true })
  residentialAddress: string;

  @Column({ type: 'enum', enum: UserRole, default: UserRole.CLIENT })
  role: UserRole;

  @Column({ default: false })
  isVerified: boolean;

  // Tark certification badge (e.g. "Tark Certified Artisan")
  @Column({ default: false })
  isCertifiedByTark: boolean;

  @Column({ nullable: true })
  certificationBadgeTitle: string;

  // Lifecycle status of KYC submission
  @Column({ default: 'NOT_SUBMITTED' })
  kycStatus: string; // 'NOT_SUBMITTED' | 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED' | 'RESUBMITTED'

  // Reputation metrics
  @Column({ type: 'decimal', precision: 3, scale: 2, default: 0.0 })
  averageRating: number;

  @Column({ default: 0 })
  totalReviewsCount: number;

  @Column({ default: 0 })
  completedJobsCount: number;

  @Column('text', { array: true, default: '{}' })
  skills: string[];

  @Column({ type: 'double precision', nullable: true })
  latitude: number;

  @Column({ type: 'double precision', nullable: true })
  longitude: number;

  // In-App Wallet & Funding Account
  @Column({ type: 'decimal', precision: 12, scale: 2, default: 0.0 })
  walletBalance: number;

  @Column({ nullable: true })
  virtualAccountNumber: string;

  @Column({ nullable: true })
  virtualBankName: string;

  @Column({ nullable: true })
  paystackCustomerCode: string;

  // Global-ready KYC / Verification
  @Column({ nullable: true })
  idType: string; // e.g. 'NIN', 'BVN', 'PASSPORT', 'NATIONAL_ID'

  @Column({ nullable: true })
  idNumber: string;

  @Column({ default: false })
  idVerified: boolean;

  // Dynamic Payout Profile (where artisan receives money)
  @Column({ default: 'paystack' })
  payoutProvider: string; // 'paystack', 'flutterwave', 'stripe', 'mpesa'

  @Column({ nullable: true })
  payoutAccountIdentifier: string; // Bank NUBAN, MoMo/M-Pesa phone number, or IBAN

  @Column({ nullable: true })
  payoutBankOrNetwork: string; // Bank code or telecom network code

  @Column({ nullable: true })
  payoutRecipientCode: string; // External gateway recipient identifier (e.g. RCP_...)

  @Column({ default: 0 })
  tokenVersion: number;

  @Column({ nullable: true, select: false })
  passwordResetTokenHash: string;

  @Column({ type: 'timestamptz', nullable: true, select: false })
  passwordResetExpiresAt: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
