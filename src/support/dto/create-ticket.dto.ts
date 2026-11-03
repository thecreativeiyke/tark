import { IsString, IsOptional, IsUUID } from 'class-validator';

export class CreateTicketDto {
  @IsString()
  message: string;

  @IsOptional()
  @IsUUID()
  jobId?: string;

  @IsOptional()
  @IsString()
  subject?: string;
}
