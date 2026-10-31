import { IsString, IsOptional, IsUUID } from 'class-validator';

export class AssignDisputeDto {
  @IsUUID()
  adminId: string;

  @IsOptional()
  @IsString()
  department?: string;
}
