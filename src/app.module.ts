import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { JobsModule } from './jobs/jobs.module';
import { CategoriesModule } from './categories/categories.module';
import { EscrowModule } from './escrow/escrow.module';
import { PaymentsModule } from './payments/payments.module';
import { MediaModule } from './media/media.module';
import { BidsModule } from './bids/bids.module';
import { ReviewsModule } from './reviews/reviews.module';
import { DisputesModule } from './disputes/disputes.module';
import { SupportModule } from './support/support.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => {
        const databaseUrl = configService.get<string>('DATABASE_URL');
        const isProduction = configService.get<string>('NODE_ENV') === 'production';
        const syncEnv = configService.get<string>('DB_SYNCHRONIZE');
        const synchronize = syncEnv !== undefined ? syncEnv === 'true' : !isProduction;
        const sslEnv = configService.get<string>('DB_SSL');
        const useSsl = sslEnv !== undefined ? sslEnv === 'true' : !!databaseUrl;

        if (databaseUrl) {
          return {
            type: 'postgres',
            url: databaseUrl,
            autoLoadEntities: true,
            synchronize,
            ssl: useSsl ? { rejectUnauthorized: false } : false,
          };
        }

        return {
          type: 'postgres',
          host: configService.get<string>('DB_HOST', 'localhost'),
          port: Number(configService.get<number>('DB_PORT', 5432)),
          username: configService.get<string>('DB_USERNAME', 'postgres'),
          password: configService.get<string>('DB_PASSWORD', 'postgres'),
          database: configService.get<string>('DB_DATABASE', 'tark'),
          autoLoadEntities: true,
          synchronize,
          ssl: useSsl ? { rejectUnauthorized: false } : false,
        };
      },
      inject: [ConfigService],
    }),
    UsersModule,
    AuthModule,
    JobsModule,
    CategoriesModule,
    EscrowModule,
    PaymentsModule,
    MediaModule,
    BidsModule,
    ReviewsModule,
    DisputesModule,
    SupportModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
