import {
  IsArray,
  IsString,
  IsUrl,
  ArrayMinSize,
  ArrayMaxSize,
  ArrayUnique,
  MaxLength,
} from 'class-validator';

export class InitiateHandshakeDto {
  @IsArray()
  @ArrayMinSize(1, {
    message:
      'At least one proof-of-work photo URL is mandatory to initiate completion handshake',
  })
  @ArrayMaxSize(10, { message: 'A maximum of 10 proof-of-work photos is allowed' })
  @ArrayUnique({ message: 'Duplicate proof-of-work URLs are not allowed' })
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  @IsUrl(
    { protocols: ['https'], require_protocol: true },
    { each: true, message: 'Each proof-of-work entry must be a valid https URL' },
  )
  proofOfWorkUrls: string[];
}
