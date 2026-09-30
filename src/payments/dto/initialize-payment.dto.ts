import { IsString } from 'class-validator';

export class InitializePaymentDto {
  @IsString()
  escrowId: string;
}
