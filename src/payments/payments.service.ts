import {
  Injectable,
  BadRequestException,
  UnauthorizedException,
  ForbiddenException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import * as crypto from 'crypto';
import { EscrowService } from '../escrow/escrow.service';
import { UsersService } from '../users/users.service';
import { EscrowStatus } from '../escrow/entities/escrow-transaction.entity';

interface PaystackInitializeResponse {
  status: boolean;
  message: string;
  data: {
    authorization_url: string;
    access_code: string;
    reference: string;
  };
}

@Injectable()
export class PaymentsService {
  constructor(
    private configService: ConfigService,
    private escrowService: EscrowService,
    private usersService: UsersService,
  ) {}

  async initialize(escrowId: string, userId: string) {
    const escrow = await this.escrowService.findOne(escrowId);

    if (escrow.clientId !== userId) {
      throw new ForbiddenException('You do not own this escrow transaction');
    }

    if (escrow.totalStatus !== EscrowStatus.INITIATED) {
      throw new BadRequestException(
        'Payment has already been initiated or completed for this escrow',
      );
    }

    if (escrow.paystackReference) {
      throw new BadRequestException(
        'Payment already initialized for this escrow',
      );
    }

    const user = await this.usersService.findOne(userId);
    if (!user) {
      throw new BadRequestException('User not found');
    }

    const totalAmount =
      Number(escrow.tranche1Amount) + Number(escrow.tranche2Amount);
    const amountInKobo = Math.round(totalAmount * 100);
    const reference = `tark-${escrow.id}-${Date.now()}`;

    const secretKey = this.configService.get<string>('PAYSTACK_SECRET_KEY');

    let response;
    try {
      response = await axios.post<PaystackInitializeResponse>(
        'https://api.paystack.co/transaction/initialize',
        {
          email: user.email,
          amount: amountInKobo,
          reference,
        },
        {
          headers: {
            Authorization: `Bearer ${secretKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        },
      );
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response) {
          throw new BadRequestException(
            `Paystack rejected the request: ${
              error.response.data?.message ?? 'unknown reason'
            }`,
          );
        }
        throw new InternalServerErrorException(
          `Could not reach Paystack: ${error.message}`,
        );
      }
      throw new InternalServerErrorException(
        'Unexpected error while initializing payment',
      );
    }

    await this.escrowService.attachPaystackReference(escrow.id, reference);

    return {
      authorizationUrl: response.data.data.authorization_url,
      reference,
    };
  }

  private verifySignature(rawBody: Buffer, signature: string): boolean {
    const secretKey = this.configService.get<string>('PAYSTACK_SECRET_KEY');
    if (!secretKey || !signature || !rawBody) {
      return false;
    }
    const expectedHash = crypto
      .createHmac('sha512', secretKey)
      .update(rawBody)
      .digest('hex');

    const expectedBuffer = Buffer.from(expectedHash, 'utf-8');
    const signatureBuffer = Buffer.from(signature, 'utf-8');

    if (expectedBuffer.length !== signatureBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(expectedBuffer, signatureBuffer);
  }

  async handleWebhook(rawBody: Buffer, signature: string) {
    const isValid = this.verifySignature(rawBody, signature);
    if (!isValid) {
      throw new UnauthorizedException('Invalid webhook signature');
    }

    const event = JSON.parse(rawBody.toString('utf-8')) as {
      event: string;
      data: { reference: string; amount: number };
    };

    if (event.event === 'charge.success') {
      const reference = event.data.reference;
      const escrow = await this.escrowService.findByReference(reference);

      if (!escrow) {
        console.warn(`Webhook received for unknown reference: ${reference}`);
        return { received: true };
      }

      if (escrow.totalStatus !== EscrowStatus.INITIATED) {
        return { received: true };
      }

      const expectedKobo = Math.round(
        (Number(escrow.tranche1Amount) + Number(escrow.tranche2Amount)) * 100,
      );
      if (event.data.amount !== expectedKobo) {
        console.error(
          `Amount mismatch for ${reference}: got ${event.data.amount}, expected ${expectedKobo}`,
        );
        return { received: true };
      }

      await this.escrowService.lockFunds(escrow.id);
    }

    return { received: true };
  }
}
