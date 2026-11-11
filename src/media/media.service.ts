import {
  Injectable,
  BadRequestException,
  InternalServerErrorException,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createStorageClient } from 'iyke-storage';
import { detectFileType, claimedKind, safeFilename } from './file-signature';

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

type UploadFolder = 'jobs/diagnostics' | 'escrow/proof-of-work' | 'avatars';

// A file whose real content has been checked. Everything downstream uses these values,
// never the client-supplied mimetype or file name.
interface InspectedFile {
  buffer: Buffer;
  safeName: string;
  mime: string;
  originalName: string;
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

  // Decides what the file REALLY is from its leading bytes. Rejects anything that is not a
  // supported image/video, or whose claimed family (image vs video) disagrees with its content.
  private inspect(file: MulterFile, folder: UploadFolder): InspectedFile {
    if (!file || !file.buffer || file.buffer.length === 0) {
      throw new BadRequestException('Empty file buffer provided');
    }

    const detected = detectFileType(file.buffer);
    if (!detected) {
      throw new BadRequestException(
        'File content is not a supported image (JPEG, PNG, WebP, HEIC) or video (MP4, MOV, WebM).',
      );
    }

    const claimed = claimedKind(file.mimetype);
    if (claimed !== detected.kind) {
      throw new BadRequestException('File type does not match its content.');
    }

    if (folder === 'avatars' && detected.kind !== 'image') {
      throw new BadRequestException('Avatars must be images.');
    }

    return {
      buffer: file.buffer,
      safeName: safeFilename(file.originalname, detected.ext),
      mime: detected.mime,
      originalName: file.originalname,
      size: file.buffer.length,
    };
  }

  private async store(
    item: InspectedFile,
    folder: UploadFolder,
    tags: string[],
  ): Promise<UploadedMediaResponse> {
    if (!this.storageClient) {
      throw new InternalServerErrorException(
        'iyke-storage client is uninitialized. Verify STORAGE_GATEWAY_URL and STORAGE_API_KEY in .env.',
      );
    }

    const webFile = new File([item.buffer as any], item.safeName, { type: item.mime });

    try {
      const result = await this.storageClient.upload(webFile, {
        folder,
        tags,
        alt: item.safeName,
      });

      return {
        cdnUrl: this.formatCdnUrl(result.cdnUrl),
        blurDataURL: result.blurDataURL,
        width: result.width,
        height: result.height,
        folder,
        originalName: item.originalName,
        mimeType: item.mime,
        size: item.size,
      };
    } catch (error: any) {
      this.logger.error(
        `iyke-storage upload failed for ${item.safeName}`,
        error?.response?.data || error.message,
      );
      throw new InternalServerErrorException(
        `Cloudflare R2 storage upload failed: ${error?.message || 'Gateway error'}`,
      );
    }
  }

  async uploadFile(
    file: MulterFile,
    folder: UploadFolder = 'jobs/diagnostics',
    tags: string[] = [],
  ): Promise<UploadedMediaResponse> {
    const item = this.inspect(file, folder);
    return this.store(item, folder, tags);
  }

  async uploadMultiple(
    files: MulterFile[],
    folder: 'jobs/diagnostics' | 'escrow/proof-of-work' = 'jobs/diagnostics',
    tags: string[] = [],
  ): Promise<UploadedMediaResponse[]> {
    if (!files || files.length === 0) {
      return [];
    }
    // Inspect EVERY file before uploading ANY, so one bad file in a batch cannot leave the
    // others orphaned in storage.
    const inspected = files.map((file) => this.inspect(file, folder));
    return Promise.all(inspected.map((item) => this.store(item, folder, tags)));
  }
}
