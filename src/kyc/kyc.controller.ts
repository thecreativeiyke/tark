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
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../users/entities/user.entity';
import { KycService } from './kyc.service';
import { SubmitKycDto } from './dto/submit-kyc.dto';
import { RejectKycDto } from './dto/reject-kyc.dto';
import { QueryKycDto } from './dto/query-kyc.dto';
import { VerifiedScopeDto } from './dto/verified-scope.dto';

@Controller('kyc')
@UseGuards(JwtAuthGuard)
export class KycController {
  constructor(private readonly kycService: KycService) {}

  /**
   * Artisan submits identity documents for Tark Verification.
   */
  @Post('submit')
  @HttpCode(HttpStatus.CREATED)
  async submitKyc(@Request() req: any, @Body() dto: SubmitKycDto) {
    return this.kycService.submitKyc(req.user.userId, req.user.role, dto);
  }

  /**
   * Artisan checks their own KYC verification status.
   */
  @Get('my-status')
  async getMyStatus(@Request() req: any) {
    return this.kycService.getMyStatus(req.user.userId);
  }

  /**
   * Secure, authorized token access to view document or selfie.
   */
  @Get('document/:id/:type')
  async getSecureDocument(
    @Request() req: any,
    @Param('id') id: string,
    @Param('type') type: 'document' | 'selfie',
  ) {
    return this.kycService.getSecureDocumentAccess(
      id,
      { userId: req.user.userId, role: req.user.role },
      type,
    );
  }

  /**
   * Admin Verification Desk Queue (Paginated & Filterable).
   */
  @Get('admin/queue')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async getAdminQueue(@Query() query: QueryKycDto) {
    return this.kycService.getAdminQueue(query);
  }

  /**
   * Admin inspection of a single KYC submission with AI dossier.
   */
  @Get('admin/:id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async getAdminRecord(@Param('id') id: string) {
    return this.kycService.getAdminRecordById(id);
  }

  /**
   * Admin 1-click Approval: Stamps Tark Certified badge and unlocks bidding.
   */
  @Patch('admin/:id/approve')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async approveKyc(
    @Request() req: any,
    @Param('id') id: string,
    @Body() dto?: VerifiedScopeDto,
  ) {
    return this.kycService.approveKyc(id, req.user.userId, dto ?? {});
  }

  /**
   * Admin sets/updates an artisan's verified trade categories and service area.
   */
  @Patch('admin/artisans/:userId/scope')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async updateVerifiedScope(
    @Request() req: any,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body() dto: VerifiedScopeDto,
  ) {
    return this.kycService.updateVerifiedScope(userId, dto ?? {}, req.user.userId);
  }

  /**
   * Admin Rejection with actionable feedback to the artisan.
   */
  @Patch('admin/:id/reject')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async rejectKyc(
    @Request() req: any,
    @Param('id') id: string,
    @Body() dto: RejectKycDto,
  ) {
    return this.kycService.rejectKyc(id, req.user.userId, dto);
  }
}
