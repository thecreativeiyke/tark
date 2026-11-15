import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import { ReviewsService } from './reviews.service';
import { CreateReviewDto } from './dto/create-review.dto';
import { ModerateReviewDto } from './dto/moderate-review.dto';
import { QueryArtisanReviewsDto } from './dto/query-artisan-reviews.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../users/entities/user.entity';

interface AuthenticatedRequest extends Request {
  user: {
    userId: string;
    email: string;
    role: string;
  };
}

@Controller('reviews')
export class ReviewsController {
  constructor(private readonly reviewsService: ReviewsService) {}

  // 1. Client submits review for a completed job
  @UseGuards(JwtAuthGuard)
  @Post()
  create(
    @Body() createDto: CreateReviewDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.reviewsService.create(createDto, req.user.userId);
  }

  // 2. Public endpoint: View approved reviews for an artisan
  @Get('artisan/:artisanId')
  getArtisanReviews(
    @Param('artisanId', new ParseUUIDPipe()) artisanId: string,
    @Query() query: QueryArtisanReviewsDto,
  ) {
    return this.reviewsService.getPublicArtisanReviews(artisanId, query);
  }

  // 3. Admin endpoint: View moderation queue of pending reviews
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Get('admin/pending')
  getPendingReviews() {
    return this.reviewsService.getPendingReviews();
  }

  // 4. Admin endpoint: Approve or reject review
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Patch(':id/moderate')
  moderate(
    @Param('id') id: string,
    @Body() dto: ModerateReviewDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.reviewsService.moderateReview(id, dto, req.user.userId);
  }
}
