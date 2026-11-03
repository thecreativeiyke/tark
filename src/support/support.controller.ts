import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { SupportService } from './support.service';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { AssignTicketDto } from './dto/assign-ticket.dto';
import { ResolveTicketDto } from './dto/resolve-ticket.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../users/entities/user.entity';
import {
  SupportDepartment,
  SupportTicketStatus,
} from './entities/support-ticket.entity';

@UseGuards(JwtAuthGuard)
@Controller('support')
export class SupportController {
  constructor(private readonly supportService: SupportService) {}

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /support/chat
  // Any logged-in user opens (or continues) a support session
  // ─────────────────────────────────────────────────────────────────────────────
  // Protected from AI quota exhaustion: max 15 requests per minute
  @Throttle({ default: { limit: 15, ttl: 60000 } })
  @Post('chat')
  createOrGetTicket(@Body() dto: CreateTicketDto, @Req() req: any) {
    return this.supportService.createOrGetTicket(dto, req.user.userId);
  }

  // Protected from AI quota exhaustion: max 15 requests per minute
  @Throttle({ default: { limit: 15, ttl: 60000 } })
  @Post(':ticketId/message')
  sendMessage(
    @Param('ticketId', ParseUUIDPipe) ticketId: string,
    @Body() dto: SendMessageDto,
    @Req() req: any,
  ) {
    return this.supportService.sendMessage(
      ticketId,
      dto,
      req.user.userId,
      req.user.role,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // GET /support/:ticketId
  // Get a single ticket with its full message thread
  // ─────────────────────────────────────────────────────────────────────────────
  @Get(':ticketId')
  getTicket(
    @Param('ticketId', ParseUUIDPipe) ticketId: string,
    @Req() req: any,
  ) {
    return this.supportService.getTicket(
      ticketId,
      req.user.userId,
      req.user.role,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // GET /support/admin/queue
  // Admin / Super Admin: view the incoming support queue
  // ─────────────────────────────────────────────────────────────────────────────
  @Get('admin/queue')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  getQueue(
    @Query('department') department?: SupportDepartment,
    @Query('status') status?: SupportTicketStatus,
    @Query('priority') priority?: string,
  ) {
    return this.supportService.getQueue(department, status, priority as any);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PATCH /support/:ticketId/assign
  // Admin assigns a ticket to a team member / department
  // ─────────────────────────────────────────────────────────────────────────────
  @Patch(':ticketId/assign')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  assignTicket(
    @Param('ticketId', ParseUUIDPipe) ticketId: string,
    @Body() dto: AssignTicketDto,
  ) {
    return this.supportService.assignTicket(ticketId, dto);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PATCH /support/:ticketId/resolve
  // Admin marks a ticket as resolved with a resolution note
  // ─────────────────────────────────────────────────────────────────────────────
  @Patch(':ticketId/resolve')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  resolveTicket(
    @Param('ticketId', ParseUUIDPipe) ticketId: string,
    @Body() dto: ResolveTicketDto,
    @Req() req: any,
  ) {
    return this.supportService.resolveTicket(ticketId, dto, req.user.userId);
  }
}
