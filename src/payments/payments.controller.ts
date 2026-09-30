import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  Param,
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

  @Get('banks')
  getSupportedBanks(
    @Query('country') country?: string,
    @Query('currency') currency?: string,
    @Query('type') type?: string,
    @Query('search') search?: string,
  ) {
    return this.paymentsService.getSupportedBanks({ country, currency, type, search });
  }

  @UseGuards(JwtAuthGuard)
  @Get('pay-for-me/:escrowId')
  getPayForMe(
    @Param('escrowId') escrowId: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.paymentsService.generatePayForMe(escrowId, req.user.userId);
  }

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
  @Post('fund-with-wallet')
  fundWithWallet(
    @Body('escrowId') escrowId: string,
    @Request() req: AuthenticatedRequest,
  ) {
    if (!escrowId) {
      throw new BadRequestException('escrowId is required');
    }
    return this.paymentsService.fundEscrowWithWallet(escrowId, req.user.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Get('bank/resolve')
  resolveBank(
    @Query('accountNumber') accountNumber: string,
    @Query('bankCode') bankCode: string,
    @Query('currency') currency?: string,
  ) {
    if (!accountNumber || !bankCode) {
      throw new BadRequestException('accountNumber and bankCode are required');
    }
    return this.paymentsService.resolveBankAccount(accountNumber, bankCode, currency || 'NGN');
  }

  @UseGuards(JwtAuthGuard)
  @Post('bank/save')
  saveBank(
    @Body('accountNumber') accountNumber: string,
    @Body('bankCode') bankCode: string,
    @Body('currency') currency: string,
    @Request() req: AuthenticatedRequest,
  ) {
    if (!accountNumber || !bankCode) {
      throw new BadRequestException('accountNumber and bankCode are required');
    }
    return this.paymentsService.saveArtisanBank(
      req.user.userId,
      accountNumber,
      bankCode,
      currency || 'NGN',
    );
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
