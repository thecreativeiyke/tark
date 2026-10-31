import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum ReviewStatus {
  PENDING_REVIEW = 'PENDING_REVIEW',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

@Entity()
export class Review {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Each completed job can only receive one client review
  @Index({ unique: true })
  @Column()
  jobId: string;

  @Column()
  clientId: string;

  @Index()
  @Column()
  artisanId: string;

  @Column({ type: 'int' })
  rating: number; // 1 to 5 stars

  @Column({ type: 'text' })
  comment: string;

  @Column('text', { array: true, default: '{}' })
  proofMediaUrls: string[];

  @Column({
    type: 'enum',
    enum: ReviewStatus,
    default: ReviewStatus.PENDING_REVIEW,
  })
  status: ReviewStatus;

  // Administrative moderation trail
  @Column({ type: 'text', nullable: true })
  adminNotes: string | null;

  @Column({ type: 'varchar', nullable: true })
  moderatedBy: string | null;

  @Column({ type: 'timestamp', nullable: true })
  moderatedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
