import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  SupportTicket,
  SupportDepartment,
  SupportTicketStatus,
  SupportPriority,
} from './entities/support-ticket.entity';
import {
  SupportMessage,
  MessageSenderRole,
} from './entities/support-message.entity';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { AssignTicketDto } from './dto/assign-ticket.dto';
import { ResolveTicketDto } from './dto/resolve-ticket.dto';
import { GeminiService, UserContext } from './gemini.service';
import { User, UserRole } from '../users/entities/user.entity';
import { Job } from '../jobs/entities/job.entity';
import { EscrowTransaction } from '../escrow/entities/escrow-transaction.entity';

@Injectable()
export class SupportService {
  private readonly logger = new Logger(SupportService.name);

  constructor(
    @InjectRepository(SupportTicket)
    private ticketsRepository: Repository<SupportTicket>,
    @InjectRepository(SupportMessage)
    private messagesRepository: Repository<SupportMessage>,
    @InjectRepository(User)
    private usersRepository: Repository<User>,
    @InjectRepository(Job)
    private jobsRepository: Repository<Job>,
    @InjectRepository(EscrowTransaction)
    private escrowRepository: Repository<EscrowTransaction>,
    private geminiService: GeminiService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────
  // 1. START OR GET ACTIVE SUPPORT TICKET
  // Initializes conversational session with AI First Responder
  // ─────────────────────────────────────────────────────────────────────
  async createOrGetTicket(dto: CreateTicketDto, userId: string) {
    const user = await this.usersRepository.findOneBy({ id: userId });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Check for an existing active ticket
    let ticket = await this.ticketsRepository.findOne({
      where: [
        { userId, status: SupportTicketStatus.AI_HANDLING },
        { userId, status: SupportTicketStatus.ASSIGNED_TO_HUMAN },
        { userId, status: SupportTicketStatus.WAITING_ON_USER },
      ],
      order: { createdAt: 'DESC' },
    });

    if (!ticket) {
      ticket = this.ticketsRepository.create({
        userId,
        jobId: dto.jobId || null,
        subject: dto.subject || 'Support Assistance',
        status: SupportTicketStatus.AI_HANDLING,
        priority: SupportPriority.MEDIUM,
        department: SupportDepartment.GENERAL_SUPPORT,
      });
      ticket = await this.ticketsRepository.save(ticket);
    }

    // Save initial user message
    const userMsg = this.messagesRepository.create({
      ticketId: ticket.id,
      senderId: user.id,
      senderRole: MessageSenderRole.USER,
      senderName: user.fullName,
      content: dto.message,
      mediaUrls: [],
    });
    await this.messagesRepository.save(userMsg);

    // If ticket is being handled by AI, process with Gemini
    if (ticket.status === SupportTicketStatus.AI_HANDLING) {
      const context = await this.buildUserContext(user, ticket.jobId);
      const history = await this.buildChatHistory(ticket.id);

      const aiResult = await this.geminiService.processMessage(dto.message, history, context);

      // Save AI reply
      const aiMsg = this.messagesRepository.create({
        ticketId: ticket.id,
        senderId: 'TARK_AI_AGENT',
        senderRole: MessageSenderRole.AI_ASSISTANT,
        senderName: 'Tark Assistant',
        content: aiResult.reply,
        mediaUrls: [],
      });
      await this.messagesRepository.save(aiMsg);

      // Check if escalation threshold was reached
      if (aiResult.needsEscalation) {
        ticket.status = SupportTicketStatus.ASSIGNED_TO_HUMAN;
        ticket.department = (aiResult.department as SupportDepartment) || SupportDepartment.GENERAL_SUPPORT;
        ticket.priority = (aiResult.priority as SupportPriority) || SupportPriority.HIGH;
        ticket.aiSummary = aiResult.succinctBrief || null;
        ticket.aiFrustrationScore = aiResult.frustrationScore || 5;
        await this.ticketsRepository.save(ticket);

        this.logger.warn(
          `[Tark AI Triage] Ticket #${ticket.id} escalated to human desk [${ticket.department}] with priority [${ticket.priority}].`,
        );
      }
    }

    return this.getTicket(ticket.id, userId, user.role);
  }

  // ─────────────────────────────────────────────────────────────────────
  // 2. SEND MESSAGE IN TICKET
  // ─────────────────────────────────────────────────────────────────────
  async sendMessage(ticketId: string, dto: SendMessageDto, userId: string, role: string) {
    const ticket = await this.ticketsRepository.findOneBy({ id: ticketId });
    if (!ticket) {
      throw new NotFoundException('Support ticket not found');
    }

    const user = await this.usersRepository.findOneBy({ id: userId });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const isAdmin = role === UserRole.ADMIN || role === UserRole.SUPER_ADMIN;
    if (!isAdmin && ticket.userId !== userId) {
      throw new ForbiddenException('Access denied to this support ticket');
    }

    const senderRole = isAdmin ? MessageSenderRole.ADMIN : MessageSenderRole.USER;
    const userMsg = this.messagesRepository.create({
      ticketId: ticket.id,
      senderId: user.id,
      senderRole,
      senderName: user.fullName,
      content: dto.content,
      mediaUrls: dto.mediaUrls || [],
    });
    await this.messagesRepository.save(userMsg);

    // If a human admin replied, mark ticket as waiting on user
    if (isAdmin) {
      ticket.status = SupportTicketStatus.WAITING_ON_USER;
      await this.ticketsRepository.save(ticket);
      return this.getTicket(ticket.id, userId, role);
    }

    // If ticket is still in AI_HANDLING, let Gemini reply
    if (ticket.status === SupportTicketStatus.AI_HANDLING) {
      const context = await this.buildUserContext(user, ticket.jobId);
      const history = await this.buildChatHistory(ticket.id);

      const aiResult = await this.geminiService.processMessage(dto.content, history, context);

      const aiMsg = this.messagesRepository.create({
        ticketId: ticket.id,
        senderId: 'TARK_AI_AGENT',
        senderRole: MessageSenderRole.AI_ASSISTANT,
        senderName: 'Tark Assistant',
        content: aiResult.reply,
        mediaUrls: [],
      });
      await this.messagesRepository.save(aiMsg);

      if (aiResult.needsEscalation) {
        ticket.status = SupportTicketStatus.ASSIGNED_TO_HUMAN;
        ticket.department = (aiResult.department as SupportDepartment) || SupportDepartment.GENERAL_SUPPORT;
        ticket.priority = (aiResult.priority as SupportPriority) || SupportPriority.HIGH;
        ticket.aiSummary = aiResult.succinctBrief || null;
        ticket.aiFrustrationScore = aiResult.frustrationScore || 5;
        await this.ticketsRepository.save(ticket);
      }
    }

    return this.getTicket(ticket.id, userId, role);
  }

  // ─────────────────────────────────────────────────────────────────────
  // 3. GET SINGLE TICKET & CONVERSATION THREAD
  // ─────────────────────────────────────────────────────────────────────
  async getTicket(ticketId: string, userId: string, role: string) {
    const ticket = await this.ticketsRepository.findOneBy({ id: ticketId });
    if (!ticket) {
      throw new NotFoundException('Support ticket not found');
    }

    const isAdmin = role === UserRole.ADMIN || role === UserRole.SUPER_ADMIN;
    if (!isAdmin && ticket.userId !== userId) {
      throw new ForbiddenException('Access denied to this ticket');
    }

    const messages = await this.messagesRepository.find({
      where: { ticketId: ticket.id },
      order: { createdAt: 'ASC' },
    });

    return {
      ticket,
      messages,
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // 4. ADMIN TRIAGE QUEUE: Categorized by department, status, priority
  // ─────────────────────────────────────────────────────────────────────
  async getQueue(department?: SupportDepartment, status?: SupportTicketStatus, priority?: SupportPriority) {
    const qb = this.ticketsRepository.createQueryBuilder('ticket');

    if (department) {
      qb.andWhere('ticket.department = :department', { department });
    }
    if (status) {
      qb.andWhere('ticket.status = :status', { status });
    }
    if (priority) {
      qb.andWhere('ticket.priority = :priority', { priority });
    }

    return qb.orderBy('ticket.priority', 'DESC').addOrderBy('ticket.createdAt', 'ASC').getMany();
  }

  // ─────────────────────────────────────────────────────────────────────
  // 5. ASSIGN OR RE-ROUTE TICKET
  // ─────────────────────────────────────────────────────────────────────
  async assignTicket(ticketId: string, dto: AssignTicketDto) {
    const ticket = await this.ticketsRepository.findOneBy({ id: ticketId });
    if (!ticket) {
      throw new NotFoundException('Ticket not found');
    }

    ticket.assignedAdminId = dto.adminId;
    if (dto.department) ticket.department = dto.department;
    if (dto.priority) ticket.priority = dto.priority;
    ticket.status = SupportTicketStatus.ASSIGNED_TO_HUMAN;

    return this.ticketsRepository.save(ticket);
  }

  // ─────────────────────────────────────────────────────────────────────
  // 6. RESOLVE TICKET
  // ─────────────────────────────────────────────────────────────────────
  async resolveTicket(ticketId: string, dto: ResolveTicketDto, adminId: string) {
    const ticket = await this.ticketsRepository.findOneBy({ id: ticketId });
    if (!ticket) {
      throw new NotFoundException('Ticket not found');
    }

    ticket.status = SupportTicketStatus.RESOLVED;
    ticket.resolutionNotes = dto.resolutionNotes;
    ticket.resolvedAt = new Date();
    ticket.assignedAdminId = adminId;

    return this.ticketsRepository.save(ticket);
  }

  // ─────────────────────────────────────────────────────────────────────
  // HELPERS: Build live user context and message history for Gemini
  // ─────────────────────────────────────────────────────────────────────
  private async buildUserContext(user: User, jobId?: string | null): Promise<UserContext> {
    const context: UserContext = {
      userName: user.fullName,
      userRole: user.role,
      walletBalance: Number(user.walletBalance || 0),
    };

    let targetJobId = jobId;
    if (!targetJobId) {
      const recentJob = await this.jobsRepository.findOne({
        where: [{ clientId: user.id }, { artisanId: user.id }],
        order: { createdAt: 'DESC' },
      });
      if (recentJob) targetJobId = recentJob.id;
    }

    if (targetJobId) {
      const job = await this.jobsRepository.findOneBy({ id: targetJobId });
      if (job) {
        let otherPartyName: string | undefined;
        const otherPartyId = user.id === job.clientId ? job.artisanId : job.clientId;
        if (otherPartyId) {
          const otherUser = await this.usersRepository.findOneBy({ id: otherPartyId });
          otherPartyName = otherUser?.fullName;
        }

        context.activeJob = {
          id: job.id,
          title: job.title,
          status: job.status,
          location: job.location,
          budget: Number(job.budget || 0),
          tranche1Amount: Number(job.tranche1Amount || 0),
          tranche2Amount: Number(job.tranche2Amount || 0),
          otherPartyName,
        };

        const escrow = await this.escrowRepository.findOneBy({ jobId: job.id });
        if (escrow) {
          context.activeEscrow = {
            id: escrow.id,
            status: escrow.totalStatus,
            t1Status: escrow.tranche1Status,
            t2Status: escrow.tranche2Status,
          };
        }
      }
    }

    return context;
  }

  private async buildChatHistory(ticketId: string) {
    const messages = await this.messagesRepository.find({
      where: { ticketId },
      order: { createdAt: 'ASC' },
      take: 20, // last 20 messages for context
    });

    return messages.map((m) => ({
      role: (m.senderRole === MessageSenderRole.USER ? 'user' : 'model') as 'user' | 'model',
      parts: [{ text: `${m.senderName}: ${m.content}` }],
    }));
  }
}
