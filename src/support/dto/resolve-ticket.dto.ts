import { IsString } from 'class-validator';

export class ResolveTicketDto {
  @IsString()
  resolutionNotes: string;
}
