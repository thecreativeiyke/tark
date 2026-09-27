import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

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

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  budget: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  tranche1Amount: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  tranche2Amount: number;

  @Column()
  location: string;

  @Column({ default: 'INITIATED' })
  status: string;

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
}
