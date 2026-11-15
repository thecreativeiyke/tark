import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JobsService } from './jobs.service';
import { JobsController } from './jobs.controller';
import { Job } from './entities/job.entity';
import { User } from '../users/entities/user.entity';
import { CategoriesModule } from '../categories/categories.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Job, User]),
    CategoriesModule,
  ],
  controllers: [JobsController],
  providers: [JobsService],
  exports: [JobsService],
})
export class JobsModule {}
