import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  Param,
  UseGuards,
  Request,
} from '@nestjs/common';
import { EscrowService } from './escrow.service';
import { CreateEscrowDto } from './dto/create-escrow.dto';
import { VerifyHandshakeDto } from './dto/verify-handshake.dto';
import { InitiateHandshakeDto } from './dto/initiate-handshake.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

interface AuthenticatedRequest extends Request {
  user: {
    userId: string;
    email: string;
    role: string;
  };
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
  findByJobId(@Param('jobId') jobId: string) {
    return this.escrowService.findByJobId(jobId);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.escrowService.findOne(id);
  }

  @Patch(':id/lock-funds')
  lockFunds(@Param('id') id: string) {
    return this.escrowService.lockFunds(id);
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
    @Body() dto: InitiateHandshakeDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.escrowService.initiateHandshake(
      id,
      req.user.userId,
      dto.proofOfWorkUrls,
    );
  }

  @Patch(':id/verify-handshake')
  verifyHandshake(
    @Param('id') id: string,
    @Body() verifyDto: VerifyHandshakeDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.escrowService.verifyHandshake(
      id,
      req.user.userId,
      verifyDto.pin,
    );
  }

  @Patch(':id/dispute')
  dispute(
    @Param('id') id: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.escrowService.dispute(id, req.user.userId);
  }
}
