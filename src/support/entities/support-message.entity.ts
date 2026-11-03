import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  Index,
} from 'typeorm';

export enum MessageSenderRole {
  USER = 'user',
  AI_ASSISTANT = 'ai',
  ADMIN = 'admin',
}

@Entity()
export class SupportMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column()
  ticketId: string;

  @Column()
  senderId: string;

  @Column({
    type: 'enum',
    enum: MessageSenderRole,
    default: MessageSenderRole.USER,
  })
  senderRole: MessageSenderRole;

  @Column()
  senderName: string;

  @Column({ type: 'text' })
  content: string;

  @Column('text', { array: true, default: '{}' })
  mediaUrls: string[];

  @CreateDateColumn()
  createdAt: Date;
}
