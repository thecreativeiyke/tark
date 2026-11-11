import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  Param,
  UseGuards,
  Request,
} from '@nestjs/common';
import { BidsService } from './bids.service';
import { CreateBidDto } from './dto/create-bid.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

interface AuthenticatedRequest extends Request {
  user: {
    userId: string;
    email: string;
    role: string;
  };
}

@Controller('bids')
export class BidsController {
  constructor(private readonly bidsService: BidsService) {}

  @UseGuards(JwtAuthGuard)
  @Post()
  create(
    @Body() dto: CreateBidDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.bidsService.create(dto, req.user.userId, req.user.role);
  }

  @UseGuards(JwtAuthGuard)
  @Get('job/:jobId')
  findByJob(
    @Param('jobId') jobId: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.bidsService.findByJobForUser(jobId, req.user.userId, req.user.role);
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id')
  findOne(
    @Param('id') id: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.bidsService.findOneForUser(id, req.user.userId, req.user.role);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id/accept')
  accept(
    @Param('id') id: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.bidsService.acceptBid(id, req.user.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id/withdraw')
  withdraw(
    @Param('id') id: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.bidsService.withdraw(id, req.user.userId);
  }
}
