import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  Headers,
  Req,
  BadRequestException,
  UseGuards,
  Request,
} from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

interface AuthenticatedRequest {
  user: {
    userId: string;
    email: string;
    role: string;
  };
  [key: string]: any;
}

@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @UseGuards(JwtAuthGuard)
  @Post('initialize')
  initializePayment(
    @Body('escrowId') escrowId: string,
    @Request() req: AuthenticatedRequest,
  ) {
    if (!escrowId) {
      throw new BadRequestException('escrowId is required');
    }
    return this.paymentsService.initializePayment(escrowId, req.user.email);
  }

  @UseGuards(JwtAuthGuard)
  @Get('bank/resolve')
  resolveBank(
    @Query('accountNumber') accountNumber: string,
    @Query('bankCode') bankCode: string,
  ) {
    if (!accountNumber || !bankCode) {
      throw new BadRequestException('accountNumber and bankCode are required');
    }
    return this.paymentsService.resolveBankAccount(accountNumber, bankCode);
  }

  @UseGuards(JwtAuthGuard)
  @Post('dedicated-account')
  assignDedicatedAccount(@Request() req: AuthenticatedRequest) {
    return this.paymentsService.assignDedicatedVirtualAccount(req.user.userId);
  }

  @Post('webhook')
  handleWebhook(
    @Headers('x-paystack-signature') signature: string,
    @Req() req: any,
  ) {
    if (!signature) {
      throw new BadRequestException('Missing signature');
    }
    const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body));
    const isValid = this.paymentsService.verifyWebhookSignature(rawBody, signature);

    if (!isValid) {
      throw new BadRequestException('Invalid signature');
    }
    return this.paymentsService.handleWebhook(req.body);
  }
}
