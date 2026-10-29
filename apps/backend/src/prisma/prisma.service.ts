import { Injectable, OnModuleDestroy, OnModuleInit, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
      datasources: {
        db: {
          url: process.env.DATABASE_URL,
        },
      },
    });
  }

  async onModuleInit() {
    try {
      await this.$connect();
      this.logger.log('Connected to Supabase PostgreSQL database.');
    } catch (err) {
      this.logger.error(`Database connection error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
    this.logger.log('Disconnected from database.');
  }

  /**
   * Helper to execute queries strictly scoped to a specific tenant ID.
   * Useful for background tasks, tenant onboarding, and batch jobs.
   */
  forTenant(tenantId: string) {
    return this.$extends({
      query: {
        $allModels: {
          async findMany({ args, query }) {
            args.where = { ...args.where, restaurantId: tenantId };
            return query(args);
          },
          async findFirst({ args, query }) {
            args.where = { ...args.where, restaurantId: tenantId };
            return query(args);
          },
        },
      },
    });
  }
}
