import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KycIdType, TarkTriageResult } from '../entities/kyc-record.entity';
import { User } from '../../users/entities/user.entity';

@Injectable()
export class KycTriageService {
  private readonly logger = new Logger(KycTriageService.name);

  constructor(private configService: ConfigService) {}

  /**
   * Evaluates identity documents, name alignment, format integrity, and risk indicators.
   * Completely white-labeled: produces standardized Tark Intelligence metrics.
   */
  async evaluateSubmission(
    user: User,
    payload: {
      idType: KycIdType;
      idNumber: string;
      documentFirstName: string;
      documentMiddleName?: string;
      documentLastName: string;
      documentUrl: string;
      documentSha256: string;
      selfieUrl: string;
      selfieSha256: string;
      expiresAt?: Date;
    },
  ): Promise<TarkTriageResult> {
    const riskFlags: string[] = [];
    const notes: string[] = [];

    // 1. Format & ID Length Checks (Nigerian Regulatory Baselines)
    const cleanIdNumber = payload.idNumber.replace(/\s+/g, '');
    if (payload.idType === KycIdType.NIN) {
      if (!/^\d{11}$/.test(cleanIdNumber)) {
        riskFlags.push('INVALID_NIN_FORMAT');
        notes.push('National Identification Number (NIN) must be exactly 11 numeric digits.');
      }
    } else if (payload.idType === KycIdType.DRIVERS_LICENSE) {
      if (cleanIdNumber.length < 10) {
        riskFlags.push('SUSPICIOUS_DRIVERS_LICENSE_LENGTH');
        notes.push('Driver license number format appears non-standard.');
      }
    } else if (payload.idType === KycIdType.VOTERS_CARD) {
      if (cleanIdNumber.length < 15) {
        riskFlags.push('SUSPICIOUS_VIN_LENGTH');
        notes.push("Voter's card VIN typically contains 19 characters.");
      }
    }

    // 2. Expiry Verification
    if (payload.expiresAt) {
      const now = new Date();
      if (new Date(payload.expiresAt) < now) {
        riskFlags.push('DOCUMENT_EXPIRED');
        notes.push('The provided identity credential has already expired.');
      } else {
        const daysRemaining = Math.floor(
          (new Date(payload.expiresAt).getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
        );
        if (daysRemaining < 30) {
          riskFlags.push('DOCUMENT_EXPIRING_SOON');
          notes.push(`Document expires in ${daysRemaining} days.`);
        }
      }
    }

    // 3. Positional Name Alignment Analysis
    const profileFull = (user.fullName || '').toLowerCase().trim();
    const docFirst = (payload.documentFirstName || '').toLowerCase().trim();
    const docLast = (payload.documentLastName || '').toLowerCase().trim();
    const docMiddle = (payload.documentMiddleName || '').toLowerCase().trim();

    let nameVerdict: 'EXACT' | 'INVERTED' | 'PARTIAL' | 'MISMATCH' = 'MISMATCH';

    const profileTokens = profileFull.split(/\s+/).filter(Boolean);
    const hasFirst = profileTokens.includes(docFirst);
    const hasLast = profileTokens.includes(docLast);

    if (profileTokens.length >= 2) {
      const profileFirstToken = profileTokens[0];
      const profileLastToken = profileTokens[profileTokens.length - 1];

      // Check strictly ordered match
      if (profileFirstToken === docFirst && profileLastToken === docLast) {
        nameVerdict = 'EXACT';
      }
      // Check inverted match (Surname entered as First name in profile)
      else if (profileFirstToken === docLast && profileLastToken === docFirst) {
        nameVerdict = 'INVERTED';
        riskFlags.push('NAME_ORDER_INVERTED_SURNAME_FIRST');
        notes.push('Name ordering appears inverted: Profile begins with Surname/Last Name.');
      } else if (hasFirst && hasLast) {
        nameVerdict = 'PARTIAL';
        notes.push('Both first and last names present, but token ordering or middle names vary.');
      } else if (hasFirst || hasLast) {
        nameVerdict = 'PARTIAL';
        riskFlags.push('NAME_PARTIALLY_MATCHED');
        notes.push('Only one name component matches registered profile name.');
      } else {
        nameVerdict = 'MISMATCH';
        riskFlags.push('NAME_MISMATCH_SUSPECTED');
        notes.push(`Profile name (${user.fullName}) does not match document name (${payload.documentFirstName} ${payload.documentLastName}).`);
      }
    } else {
      if (hasFirst || hasLast) {
        nameVerdict = 'PARTIAL';
      } else {
        nameVerdict = 'MISMATCH';
        riskFlags.push('NAME_MISMATCH_SUSPECTED');
      }
    }

    // 4. Cryptographic Hash Validation
    const shaRegex = /^[a-f0-9]{64}$/i;
    if (!shaRegex.test(payload.documentSha256)) {
      riskFlags.push('DOCUMENT_HASH_UNVERIFIED');
    }
    if (!shaRegex.test(payload.selfieSha256)) {
      riskFlags.push('SELFIE_HASH_UNVERIFIED');
    }

    // 5. Calculate Confidence Tier & Summary
    let confidenceTier: 'HIGH' | 'MEDIUM' | 'LOW' = 'HIGH';
    let status: 'SUCCESS' | 'AMBIGUOUS' | 'FAILED' = 'SUCCESS';

    if (riskFlags.includes('NAME_MISMATCH_SUSPECTED') || riskFlags.includes('DOCUMENT_EXPIRED')) {
      confidenceTier = 'LOW';
      status = 'FAILED';
    } else if (riskFlags.length > 0) {
      confidenceTier = 'MEDIUM';
      status = 'AMBIGUOUS';
    }

    const summaryParts: string[] = [];
    summaryParts.push(`Doc: ${payload.idType} (••••${cleanIdNumber.slice(-4)})`);
    summaryParts.push(`Name Alignment: ${nameVerdict}`);
    if (notes.length > 0) {
      summaryParts.push(notes.join(' '));
    } else {
      summaryParts.push('Format and name checks passed.');
    }
    // Be explicit about what this engine does NOT do, so no reviewer mistakes it for verification.
    summaryParts.push(
      'NOT PERFORMED: the ID number was not checked with the issuing authority, and the selfie was not compared to the document photo by software. The reviewer must compare them manually.',
    );

    return {
      engineVersion: 'Tark-Intelligence-v1',
      status,
      confidenceTier,
      detectedDocumentType: payload.idType,
      nameAlignment: {
        verdict: nameVerdict,
        enteredFirst: payload.documentFirstName,
        enteredMiddle: payload.documentMiddleName,
        enteredLast: payload.documentLastName,
        notes: notes.join('; '),
      },
      // faceMatchScore intentionally omitted: no face comparison is performed. A fabricated score
      // here would mislead the human reviewer.
      riskFlags,
      triageSummary: summaryParts.join(' | '),
      analyzedAt: new Date().toISOString(),
    };
  }
}
