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

  // User-scoped: masks the PIN from artisans, enforces ownership
  @Get('job/:jobId')
  findByJobId(
    @Param('jobId') jobId: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.escrowService.findByJobForUser(jobId, req.user.userId);
  }

  // User-scoped: masks the PIN from artisans, enforces ownership
  @Get(':id')
  findOne(
    @Param('id') id: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.escrowService.findOneForUser(id, req.user.userId);
  }

  // NOTE: There is intentionally NO public lock-funds route.
  // Funds are locked exclusively by the Paystack webhook after
  // payment is confirmed. This prevents anyone from faking a payment.

  @Patch(':id/release-tranche1')
  releaseTranche1(
    @Param('id') id: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.escrowService.releaseTranche1(id, req.user.userId);
  }

  @Patch(':id/initiate-handshake')
  async initiateHandshake(
    @Param('id') id: string,
    @Body() dto: InitiateHandshakeDto,
    @Request() req: AuthenticatedRequest,
  ) {
    const result = await this.escrowService.initiateHandshake(
      id,
      req.user.userId,
      dto.proofOfWorkUrls,
    );

    // The PIN is returned here so it can be forwarded to the client
    // via SMS/push notification (to be wired up with the notifications module).
    // We strip it from the response the artisan sees — they should never see it.
    // For now we return it in the response; the notifications layer will own delivery.
    return {
      message: result.message,
      expiresAt: result.expiresAt,
      // TODO: remove pin from response once SMS/push notification is live.
      // For now this is the only way the client receives it.
      clientPin: result.pin,
    };
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
