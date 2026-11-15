import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  ParseUUIDPipe,
  Delete,
  Query,
  UseGuards,
  Request,
  UnauthorizedException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JobsService } from './jobs.service';
import { CreateJobDto } from './dto/create-job.dto';
import { UpdateJobDto } from './dto/update-job.dto';
import { QueryJobDto } from './dto/query-job.dto';
import { QueryMyJobsDto } from './dto/query-my-jobs.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
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

@Controller('jobs')
export class JobsController {
  constructor(private readonly jobsService: JobsService) {}

  @UseGuards(JwtAuthGuard)
  @Post()
  create(
    @Body() createJobDto: CreateJobDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.jobsService.create(createJobDto, req.user.userId);
  }

  /** Artisan discovery: OPEN jobs inside the artisan's admin-verified categories and area. */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ARTISAN)
  @Get()
  findAll(@Query() query: QueryJobDto, @Request() req: AuthenticatedRequest) {
    const userId = req.user?.userId;
    if (!userId) {
      throw new UnauthorizedException();
    }
    return this.jobsService.findDiscoverable(query, userId);
  }

  // NOTE: static routes ('me', 'teaser') must stay declared before ':id'.

  @UseGuards(JwtAuthGuard)
  @Get('me')
  findMine(@Query() query: QueryMyJobsDto, @Request() req: AuthenticatedRequest) {
    const userId = req.user?.userId;
    if (!userId) {
      throw new UnauthorizedException();
    }
    return this.jobsService.findMine(userId, query);
  }

  /** Public, anonymous-safe preview: no JWT guard, tightly throttled. */
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Get('teaser')
  getTeaser() {
    return this.jobsService.getTeaser();
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Get(':id')
  findOne(@Param('id', new ParseUUIDPipe()) id: string, @Request() req: any) {
    return this.jobsService.findOneForCaller(id, req.user);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() updateJobDto: UpdateJobDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.jobsService.update(id, updateJobDto, req.user.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  remove(
    @Param('id') id: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.jobsService.remove(id, req.user.userId);
  }
}
