import {
  Injectable,
  BadRequestException,
  InternalServerErrorException,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createStorageClient } from 'iyke-storage';

export interface MulterFile {
  fieldname?: string;
  originalname: string;
  encoding?: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export interface UploadedMediaResponse {
  cdnUrl: string;
  blurDataURL?: string;
  width?: number;
  height?: number;
  folder: string;
  originalName: string;
  mimeType: string;
  size: number;
}

@Injectable()
export class MediaService implements OnModuleInit {
  private readonly logger = new Logger(MediaService.name);
  private storageClient: any;

  constructor(private configService: ConfigService) {}

  onModuleInit() {
    const gatewayUrl = this.configService.get<string>('STORAGE_GATEWAY_URL');
    const apiKey = this.configService.get<string>('STORAGE_API_KEY');

    if (!gatewayUrl || !apiKey) {
      this.logger.warn(
        'STORAGE_GATEWAY_URL or STORAGE_API_KEY not configured. Storage calls will fail until set.',
      );
      return;
    }

    try {
      this.storageClient = createStorageClient({
        gatewayUrl,
        apiKey,
        defaultQuality: 0.88,
        maxDimension: 2560,
        generateBlur: true,
      });
      this.logger.log(`iyke-storage initialized against gateway: ${gatewayUrl}`);
    } catch (err: any) {
      this.logger.error(`Failed to initialize iyke-storage: ${err.message}`);
    }
  }

  private formatCdnUrl(rawUrl: string): string {
    const customCdn = this.configService.get<string>('STORAGE_CUSTOM_CDN_URL');
    if (!customCdn) {
      return rawUrl;
    }

    try {
      const parsedRaw = new URL(rawUrl);
      const parsedCustom = new URL(customCdn);
      parsedRaw.protocol = parsedCustom.protocol;
      parsedRaw.host = parsedCustom.host;
      return parsedRaw.toString();
    } catch {
      return rawUrl;
    }
  }

  async uploadFile(
    file: MulterFile,
    folder: 'jobs/diagnostics' | 'escrow/proof-of-work' | 'avatars' = 'jobs/diagnostics',
    tags: string[] = [],
  ): Promise<UploadedMediaResponse> {
    if (!file || !file.buffer) {
      throw new BadRequestException('Empty file buffer provided');
    }

    if (!this.storageClient) {
      throw new InternalServerErrorException(
        'iyke-storage client is uninitialized. Verify STORAGE_GATEWAY_URL and STORAGE_API_KEY in .env.',
      );
    }

    const webFile = new File([file.buffer as any], file.originalname, {
      type: file.mimetype,
    });

    try {
      const result = await this.storageClient.upload(webFile, {
        folder,
        tags,
        alt: file.originalname,
      });

      return {
        cdnUrl: this.formatCdnUrl(result.cdnUrl),
        blurDataURL: result.blurDataURL,
        width: result.width,
        height: result.height,
        folder,
        originalName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
      };
    } catch (error: any) {
      this.logger.error(
        `iyke-storage upload failed for ${file.originalname}`,
        error?.response?.data || error.message,
      );
      throw new InternalServerErrorException(
        `Cloudflare R2 storage upload failed: ${error?.message || 'Gateway error'}`,
      );
    }
  }

  async uploadMultiple(
    files: MulterFile[],
    folder: 'jobs/diagnostics' | 'escrow/proof-of-work' = 'jobs/diagnostics',
    tags: string[] = [],
  ): Promise<UploadedMediaResponse[]> {
    if (!files || files.length === 0) {
      return [];
    }
    return Promise.all(files.map((file) => this.uploadFile(file, folder, tags)));
  }
}
