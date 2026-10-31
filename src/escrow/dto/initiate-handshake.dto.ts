import { IsArray, IsString, ArrayMinSize } from 'class-validator';

export class InitiateHandshakeDto {
  @IsArray()
  @ArrayMinSize(1, { message: 'At least one proof-of-work photo URL is mandatory to initiate completion handshake' })
  @IsString({ each: true })
  proofOfWorkUrls: string[];
}
