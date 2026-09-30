import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  UseGuards,
  Request,
} from '@nestjs/common';
import { EscrowService } from './escrow.service';
import { CreateEscrowDto } from './dto/create-escrow.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

interface AuthenticatedRequest {
  user: {
    userId: string;
    email: string;
    role: string;
  };
  [key: string]: any;
}

@Controller('escrow')
@UseGuards(JwtAuthGuard)
export class EscrowController {
  constructor(private readonly escrowService: EscrowService) {}

  @Post()
  create(
    @Body() createEscrowDto: CreateEscrowDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.escrowService.create(createEscrowDto, req.user.userId);
  }

  @Get('job/:jobId')
  findByJob(
    @Param('jobId') jobId: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.escrowService.findByJobForUser(jobId, req.user.userId);
  }

  @Get(':id')
  findOne(
    @Param('id') id: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.escrowService.findOneForUser(id, req.user.userId);
  }

  @Patch(':id/release-tranche1')
  releaseTranche1(
    @Param('id') id: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.escrowService.releaseTranche1(id, req.user.userId);
  }

  @Patch(':id/initiate-handshake')
  initiateHandshake(
    @Param('id') id: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.escrowService.initiateHandshake(id, req.user.userId);
  }

  @Patch(':id/verify-handshake')
  verifyHandshake(
    @Param('id') id: string,
    @Body('pin') pin: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.escrowService.verifyHandshake(id, req.user.userId, pin);
  }

  @Patch(':id/settle')
  settle(
    @Param('id') id: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.escrowService.settle(id, req.user.userId);
  }

  @Patch(':id/dispute')
  dispute(
    @Param('id') id: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.escrowService.dispute(id, req.user.userId);
  }
}
