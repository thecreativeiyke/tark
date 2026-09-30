import {
  Controller,
  Post,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { MediaService } from './media.service';
import type { MulterFile } from './media.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

const mediaFilter = (req: any, file: MulterFile, callback: any) => {
  if (!file.mimetype.match(/\/(jpg|jpeg|png|webp|heic|mp4|quicktime|webm)$/)) {
    return callback(
      new BadRequestException(
        'Only images (JPEG, PNG, WebP, HEIC) and videos (MP4, MOV, WebM) are allowed',
      ),
      false,
    );
  }
  callback(null, true);
};

@Controller('media')
@UseGuards(JwtAuthGuard)
export class MediaController {
  constructor(private readonly mediaService: MediaService) {}

  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 25 * 1024 * 1024 },
      fileFilter: mediaFilter,
    }),
  )
  async uploadSingle(@UploadedFile() file: MulterFile) {
    return this.mediaService.uploadFile(file, 'jobs/diagnostics');
  }

  @Post('job-diagnostics')
  @UseInterceptors(
    FilesInterceptor('files', 5, {
      limits: { fileSize: 25 * 1024 * 1024 },
      fileFilter: mediaFilter,
    }),
  )
  async uploadJobDiagnostics(@UploadedFiles() files: MulterFile[]) {
    return this.mediaService.uploadMultiple(files, 'jobs/diagnostics', ['diagnostic', 'marketplace']);
  }

  @Post('proof-of-work')
  @UseInterceptors(
    FilesInterceptor('files', 5, {
      limits: { fileSize: 25 * 1024 * 1024 },
      fileFilter: mediaFilter,
    }),
  )
  async uploadProofOfWork(@UploadedFiles() files: MulterFile[]) {
    return this.mediaService.uploadMultiple(files, 'escrow/proof-of-work', ['proof-of-work', 'handshake']);
  }
}
