import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import { DisputesService } from './disputes.service';
import { CreateDisputeDto } from './dto/create-dispute.dto';
import { RespondDisputeDto } from './dto/respond-dispute.dto';
import { ResolveDisputeDto } from './dto/resolve-dispute.dto';
import { AssignDisputeDto } from './dto/assign-dispute.dto';
import { DisputeStatus } from './entities/dispute.entity';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../users/entities/user.entity';

interface AuthenticatedRequest extends Request {
  user: {
    userId: string;
    email: string;
    role: string;
  };
}

@Controller('disputes')
@UseGuards(JwtAuthGuard)
export class DisputesController {
  constructor(private readonly disputesService: DisputesService) {}

  // 1. Client or Artisan files a dispute ticket
  @Post()
  create(
    @Body() dto: CreateDisputeDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.disputesService.create(dto, req.user.userId);
  }

  // 2. Opposing party responds with counter-evidence
  @Post(':id/respond')
  respond(
    @Param('id') id: string,
    @Body() dto: RespondDisputeDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.disputesService.respond(id, dto, req.user.userId);
  }

  // 3. View dispute details (Initiator, Respondent, or Admin)
  @Get(':id')
  findOne(
    @Param('id') id: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.disputesService.findOne(id, req.user.userId, req.user.role);
  }

  // 4. Admin queue: View all dispute tickets
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Get('admin/queue')
  getQueue(
    @Query('status') status?: DisputeStatus,
    @Query('department') department?: string,
  ) {
    return this.disputesService.getQueue(status, department);
  }

  // 5. Admin: Assign dispute or transfer between departments
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Patch(':id/assign')
  assign(
    @Param('id') id: string,
    @Body() dto: AssignDisputeDto,
  ) {
    return this.disputesService.assign(id, dto);
  }

  // 6. Admin: Execute binding resolution verdict
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Patch(':id/resolve')
  resolve(
    @Param('id') id: string,
    @Body() dto: ResolveDisputeDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.disputesService.resolve(id, dto, req.user.userId);
  }
}
