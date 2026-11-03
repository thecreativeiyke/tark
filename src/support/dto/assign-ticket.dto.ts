import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { SupportDepartment, SupportPriority } from '../entities/support-ticket.entity';

export class AssignTicketDto {
  @IsUUID()
  adminId: string;

  @IsOptional()
  @IsEnum(SupportDepartment)
  department?: SupportDepartment;

  @IsOptional()
  @IsEnum(SupportPriority)
  priority?: SupportPriority;
}
