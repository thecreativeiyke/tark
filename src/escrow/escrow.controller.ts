import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Patch,
  UseGuards,
  Request,
} from '@nestjs/common';
import { EscrowService } from './escrow.service';
import { CreateEscrowDto } from './dto/create-escrow.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

interface AuthenticatedRequest extends Request {
  user: {
    userId: string;
    email: string;
    role: string;
  };
}

@UseGuards(JwtAuthGuard)
@Controller('escrow')
export class EscrowController {
  constructor(private readonly escrowService: EscrowService) {}

  @Post()
  create(
    @Body() createEscrowDto: CreateEscrowDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.escrowService.create(createEscrowDto, req.user.userId);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.escrowService.findOne(id);
  }

  @Get('job/:jobId')
  findByJob(@Param('jobId') jobId: string) {
    return this.escrowService.findByJob(jobId);
  }

  @Patch(':id/lock-funds')
  lockFunds(@Param('id') id: string) {
    return this.escrowService.lockFunds(id);
  }

  @Patch(':id/release-tranche1')
  releaseTranche1(@Param('id') id: string) {
    return this.escrowService.releaseTranche1(id);
  }

  @Patch(':id/initiate-handshake')
  initiateHandshake(@Param('id') id: string) {
    return this.escrowService.initiateHandshake(id);
  }

  @Patch(':id/settle')
  settle(@Param('id') id: string) {
    return this.escrowService.settle(id);
  }

  @Patch(':id/dispute')
  dispute(@Param('id') id: string) {
    return this.escrowService.dispute(id);
  }
}
