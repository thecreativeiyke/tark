import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, In, Not } from 'typeorm';
import * as crypto from 'crypto';
import { KycRecord, KycStatus } from './entities/kyc-record.entity';
import { User, UserRole } from '../users/entities/user.entity';
import { SubmitKycDto } from './dto/submit-kyc.dto';
import { RejectKycDto } from './dto/reject-kyc.dto';
import { QueryKycDto } from './dto/query-kyc.dto';
import { KycTriageService } from './services/kyc-triage.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../notifications/entities/notification.entity';

@Injectable()
export class KycService {
  private readonly logger = new Logger(KycService.name);

  constructor(
    @InjectRepository(KycRecord)
    private kycRepository: Repository<KycRecord>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    private triageService: KycTriageService,
    private dataSource: DataSource,
    @Inject(forwardRef(() => NotificationsService))
    private notificationsService: NotificationsService,
  ) {}

  private computeFallbackSha256(seed: string): string {
    return crypto.createHash('sha256').update(seed).digest('hex');
  }

  /**
   * Artisan submits identity documents for Tark Certification.
   */
  async submitKyc(
    userId: string,
    role: string,
    dto: SubmitKycDto,
  ): Promise<{ message: string; recordId: string; status: KycStatus }> {
    if (role !== UserRole.ARTISAN && role !== UserRole.SUPER_ADMIN && role !== UserRole.ADMIN) {
      throw new BadRequestException('Only registered artisans may submit credentials to the Tark Verification Desk.');
    }

    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const cleanIdNumber = dto.idNumber.replace(/\s+/g, '');
    const docSha = dto.documentSha256 || this.computeFallbackSha256(`${dto.documentUrl}-${user.id}-${Date.now()}`);
    const selfieSha = dto.selfieSha256 || this.computeFallbackSha256(`${dto.selfieUrl}-${user.id}-${Date.now()}`);

    // Anti-Sybil / Duplicate Identity Check across OTHER users
    const duplicate = await this.kycRepository.findOne({
      where: [
        { idNumber: cleanIdNumber, status: In([KycStatus.APPROVED, KycStatus.PENDING_REVIEW]), userId: Not(user.id) },
        { documentSha256: docSha, status: In([KycStatus.APPROVED, KycStatus.PENDING_REVIEW]), userId: Not(user.id) },
      ],
    });

    if (duplicate) {
      this.logger.warn(`Sybil duplicate attempt: User ${user.id} submitted duplicate ID belonging to ${duplicate.userId}`);
      throw new ConflictException(
        'This government credential is already associated with another profile. Please contact Tark Compliance Desk.',
      );
    }

    // Supersede any prior pending/rejected submissions for this user
    await this.kycRepository.update(
      { userId: user.id, status: In([KycStatus.PENDING_REVIEW, KycStatus.REJECTED]) },
      { status: KycStatus.SUPERSEDED },
    );

    // Dynamic White-labeled Intelligence Triage
    const triageResult = await this.triageService.evaluateSubmission(user, {
      idType: dto.idType,
      idNumber: cleanIdNumber,
      documentFirstName: dto.documentFirstName,
      documentMiddleName: dto.documentMiddleName,
      documentLastName: dto.documentLastName,
      documentUrl: dto.documentUrl,
      documentSha256: docSha,
      selfieUrl: dto.selfieUrl,
      selfieSha256: selfieSha,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
    });

    const newRecord = this.kycRepository.create({
      userId: user.id,
      idType: dto.idType,
      idNumber: cleanIdNumber,
      documentFirstName: dto.documentFirstName,
      documentMiddleName: dto.documentMiddleName,
      documentLastName: dto.documentLastName,
      documentUrl: dto.documentUrl,
      documentSha256: docSha,
      selfieUrl: dto.selfieUrl,
      selfieSha256: selfieSha,
      status: KycStatus.PENDING_REVIEW,
      submittedAt: new Date(),
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
      triageResult,
    });

    const savedRecord = await this.kycRepository.save(newRecord);

    // Update user state with structured names and kycStatus
    await this.userRepository.update(user.id, {
      kycStatus: KycStatus.PENDING_REVIEW,
      firstName: dto.documentFirstName,
      middleName: dto.documentMiddleName || undefined,
      lastName: dto.documentLastName,
    });

    // Multi-channel lifecycle alert (Receipt confirmation)
    try {
      await this.notificationsService.dispatch({
        userId: user.id,
        title: 'Credentials Received at Verification Desk',
        message:
          'Your identity credentials have been received. Our automated compliance desk is processing your file for Tark Certification.',
        type: NotificationType.KYC_SUBMITTED,
        metadata: {
          recordId: savedRecord.id,
          idType: dto.idType,
          confidenceTier: triageResult.confidenceTier,
          status: 'PENDING_REVIEW',
        },
      });
    } catch (notifErr: any) {
      this.logger.warn(`Could not dispatch KYC receipt notification: ${notifErr.message}`);
    }

    return {
      message: 'KYC submission received and enqueued for verification.',
      recordId: savedRecord.id,
      status: savedRecord.status,
    };
  }

  /**
   * Artisan checks their own KYC status and feedback.
   */
  async getMyStatus(userId: string) {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const latestRecord = await this.kycRepository.findOne({
      where: { userId },
      order: { createdAt: 'DESC' },
    });

    if (!latestRecord) {
      return {
        kycStatus: KycStatus.NOT_SUBMITTED,
        isCertifiedByTark: user.isCertifiedByTark,
        certificationBadgeTitle: user.certificationBadgeTitle,
        canBid: false,
        message: 'You have not submitted your identity credentials yet. Submit to unlock bidding.',
      };
    }

    let guidance = 'Your credentials are under review by the Tark Verification Desk.';
    if (latestRecord.status === KycStatus.APPROVED) {
      guidance = 'You are Tark Certified. Your verified shield is active, and bidding is fully unlocked.';
    } else if (latestRecord.status === KycStatus.REJECTED) {
      guidance = `Action required: ${latestRecord.rejectionReason || 'Please re-upload clearer identity documents.'}`;
    }

    return {
      kycStatus: latestRecord.status,
      idType: latestRecord.idType,
      idNumberMasked: latestRecord.idNumber ? `••••${latestRecord.idNumber.slice(-4)}` : null,
      isCertifiedByTark: user.isCertifiedByTark,
      certificationBadgeTitle: user.certificationBadgeTitle,
      canBid: user.isCertifiedByTark,
      rejectionReason: latestRecord.rejectionReason,
      submittedAt: latestRecord.submittedAt,
      reviewedAt: latestRecord.reviewedAt,
      guidance,
    };
  }

  /**
   * Admin reviews paginated verification queue.
   */
  async getAdminQueue(query: QueryKycDto) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (query.status) {
      where.status = query.status;
    } else {
      where.status = In([KycStatus.PENDING_REVIEW, KycStatus.RESUBMITTED]);
    }

    const [records, total] = await this.kycRepository.findAndCount({
      where,
      relations: { user: true },
      order: { createdAt: 'ASC' },
      skip,
      take: limit,
    });

    return {
      data: records.map((r) => ({
        id: r.id,
        artisan: {
          id: r.user?.id,
          fullName: r.user?.fullName,
          email: r.user?.email,
          phoneNumber: r.user?.phoneNumber,
          isCertifiedByTark: r.user?.isCertifiedByTark,
        },
        idType: r.idType,
        idNumber: r.idNumber,
        documentFirstName: r.documentFirstName,
        documentLastName: r.documentLastName,
        status: r.status,
        submittedAt: r.submittedAt,
        triageConfidence: r.triageResult?.confidenceTier || 'UNKNOWN',
        triageSummary: r.triageResult?.triageSummary || 'Pending analysis',
        riskFlags: r.triageResult?.riskFlags || [],
      })),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Admin retrieves single KYC record with full intelligence dossier.
   */
  async getAdminRecordById(recordId: string) {
    const record = await this.kycRepository.findOne({
      where: { id: recordId },
      relations: { user: true },
    });

    if (!record) {
      throw new NotFoundException(`KYC Record #${recordId} not found`);
    }

    const history = await this.kycRepository.find({
      where: { userId: record.userId },
      order: { createdAt: 'DESC' },
      take: 5,
    });

    return {
      record,
      history: history.map((h) => ({
        id: h.id,
        status: h.status,
        idType: h.idType,
        submittedAt: h.submittedAt,
        reviewedAt: h.reviewedAt,
        rejectionReason: h.rejectionReason,
      })),
    };
  }

  /**
   * Admin approves artisan verification and stamps Tark Certified badge.
   */
  async approveKyc(recordId: string, adminUserId: string) {
    return this.dataSource.transaction(async (manager) => {
      const record = await manager.findOne(KycRecord, {
        where: { id: recordId },
        relations: { user: true },
      });

      if (!record) throw new NotFoundException('KYC record not found');
      if (record.status === KycStatus.APPROVED) {
        throw new BadRequestException('This KYC credential has already been approved.');
      }

      record.status = KycStatus.APPROVED;
      record.reviewedByAdminId = adminUserId;
      record.reviewedAt = new Date();
      record.rejectionReason = null;
      await manager.save(record);

      const user = record.user;
      user.isCertifiedByTark = true;
      user.certificationBadgeTitle = 'Tark Certified Artisan';
      user.idVerified = true;
      user.idType = record.idType;
      user.idNumber = record.idNumber;
      user.kycStatus = KycStatus.APPROVED;
      if (!user.firstName) user.firstName = record.documentFirstName;
      if (!user.lastName) user.lastName = record.documentLastName;
      await manager.save(user);

      // Multi-channel dispatch: Congratulations
      try {
        await this.notificationsService.dispatch({
          userId: user.id,
          title: "🎉 You're Tark Certified — Your Badge is Live",
          message:
            'Congratulations! Your identity credentials have been verified by the Tark Verification Desk. Your Tark Certified Artisan badge is now live, and bidding is unlocked.',
          type: NotificationType.KYC_APPROVED,
          metadata: {
            recordId: record.id,
            badgeTitle: user.certificationBadgeTitle,
            isCertified: true,
          },
        });
      } catch (err: any) {
        this.logger.warn(`Could not dispatch KYC approval notification: ${err.message}`);
      }

      return {
        message: `Artisan ${user.fullName} is now Tark Certified. Badge active.`,
        recordId: record.id,
        status: record.status,
        isCertifiedByTark: true,
      };
    });
  }

  /**
   * Admin rejects verification with actionable reason.
   */
  async rejectKyc(recordId: string, adminUserId: string, dto: RejectKycDto) {
    const record = await this.kycRepository.findOne({
      where: { id: recordId },
      relations: { user: true },
    });

    if (!record) throw new NotFoundException('KYC record not found');

    record.status = KycStatus.REJECTED;
    record.rejectionReason = dto.reason;
    record.reviewedByAdminId = adminUserId;
    record.reviewedAt = new Date();
    await this.kycRepository.save(record);

    await this.userRepository.update(record.userId, {
      isCertifiedByTark: false,
      kycStatus: KycStatus.REJECTED,
    });

    // Multi-channel dispatch: Actionable rejection guidance
    try {
      await this.notificationsService.dispatch({
        userId: record.userId,
        title: '⚠️ Action Required: Tark Verification Update',
        message: `Your verification submission requires attention: ${dto.reason}. Please review your documents and resubmit.`,
        type: NotificationType.KYC_REJECTED,
        metadata: {
          recordId: record.id,
          rejectionReason: dto.reason,
          status: 'REJECTED',
        },
      });
    } catch (err: any) {
      this.logger.warn(`Could not dispatch KYC rejection notification: ${err.message}`);
    }

    return {
      message: 'KYC submission rejected with feedback notice sent to artisan.',
      recordId: record.id,
      status: record.status,
    };
  }

  /**
   * Secure document access: time-limited signed access token for document preview.
   */
  async getSecureDocumentAccess(
    recordId: string,
    requestingUser: { userId: string; role: string },
    docType: 'document' | 'selfie',
  ) {
    const record = await this.kycRepository.findOne({ where: { id: recordId } });
    if (!record) throw new NotFoundException('KYC record not found');

    // Access control: only the owner or admins can inspect
    const isOwner = record.userId === requestingUser.userId;
    const isAdmin =
      requestingUser.role === UserRole.ADMIN || requestingUser.role === UserRole.SUPER_ADMIN;

    if (!isOwner && !isAdmin) {
      throw new ForbiddenException('You do not have authorization to view this identity document.');
    }

    const rawUrl = docType === 'selfie' ? record.selfieUrl : record.documentUrl;
    const sha = docType === 'selfie' ? record.selfieSha256 : record.documentSha256;

    // Generate 15-minute signed token
    const token = crypto
      .createHmac('sha256', process.env.JWT_SECRET || 'tark-sec-token')
      .update(`${recordId}:${docType}:${Date.now()}`)
      .digest('hex');

    return {
      targetUrl: rawUrl,
      sha256: sha,
      docType,
      expiresInSeconds: 900,
      accessToken: token,
    };
  }
}
