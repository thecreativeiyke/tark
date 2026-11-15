import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  Index,
} from 'typeorm';

export enum JobStatus {
  OPEN = 'OPEN',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  DISPUTED = 'DISPUTED',
  CANCELLED = 'CANCELLED',
}

@Index('IDX_job_clientId', ['clientId'])
@Index('IDX_job_artisanId', ['artisanId'])
@Index('IDX_job_status_category_createdAt', ['status', 'category', 'createdAt'])
@Entity()
export class Job {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  title: string;

  @Column({ type: 'text' })
  description: string;

  @Column()
  category: string;

  @Column({ default: 'NGN' })
  currency: string;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  budget: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  tranche1Amount: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  tranche2Amount: number;

  @Column()
  location: string;

  // Normalized coarse area (city level), derived server-side from `location`.
  @Column({ type: 'varchar', length: 64, nullable: true })
  areaCode: string | null;

  @Column({ type: 'double precision', nullable: true })
  latitude: number;

  @Column({ type: 'double precision', nullable: true })
  longitude: number;

  @Column({
    type: 'enum',
    enum: JobStatus,
    default: JobStatus.OPEN,
  })
  status: JobStatus;

  @Column()
  clientId: string;

  @Column({ nullable: true })
  artisanId: string;

  @Column('text', { array: true, nullable: true })
  mediaUrls: string[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @DeleteDateColumn()
  deletedAt: Date | null;
}
