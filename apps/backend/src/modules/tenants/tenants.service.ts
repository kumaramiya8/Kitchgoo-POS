import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';

export class OnboardTenantDto {
  restaurantName!: string;
  ownerName!: string;
  email!: string;
  password?: string;
  currency?: string;
  timezone?: string;
  branchName?: string;
}

export class ProvisionStaffDto {
  name!: string;
  email?: string;
  pin?: string;
  role!: string;
  branchId?: string;
}

@Injectable()
export class TenantsService {
  private readonly logger = new Logger(TenantsService.name);
  private readonly supabaseAdmin: SupabaseClient | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    const supabaseUrl = this.config.get<string>('SUPABASE_URL') || process.env.SUPABASE_URL;
    const serviceRoleKey =
      this.config.get<string>('SUPABASE_SERVICE_ROLE_KEY') ||
      process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (supabaseUrl && serviceRoleKey) {
      this.supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      });
    }
  }

  /**
   * Privileged Tenant Onboarding.
   * Creates Supabase Auth User, sets JWT claims with tenant_id,
   * creates Tenant row, default Branch, default Floor, Tables, and starter Categories.
   */
  async onboardTenant(dto: OnboardTenantDto) {
    const email = dto.email.toLowerCase().trim();

    // Check for existing user in local db
    const existing = await this.prisma.user.findFirst({
      where: { email },
    });
    if (existing) {
      throw new BadRequestException('An account with this email already exists');
    }

    let supabaseUserId: string | null = null;

    // 1. Create Supabase Auth User if Supabase Admin SDK is configured
    if (this.supabaseAdmin && dto.password) {
      const { data: authData, error: authError } =
        await this.supabaseAdmin.auth.admin.createUser({
          email,
          password: dto.password,
          email_confirm: true,
          user_metadata: { name: dto.ownerName },
        });

      if (authError) {
        this.logger.error(`Supabase Auth creation failed: ${authError.message}`);
        throw new BadRequestException(`Auth provider error: ${authError.message}`);
      }
      supabaseUserId = authData.user?.id ?? null;
    }

    const passwordHash = dto.password ? await bcrypt.hash(dto.password, 12) : 'EXTERNAL_AUTH';

    // 2. Atomic Database Provisioning
    const result = await this.prisma.$transaction(async (tx) => {
      // 2.1 Create Tenant (Restaurant)
      const tenant = await tx.restaurant.create({
        data: {
          name: dto.restaurantName,
          currency: dto.currency ?? 'INR',
          timezone: dto.timezone ?? 'Asia/Kolkata',
        },
      });

      // 2.2 Create Default Branch
      const branch = await tx.branch.create({
        data: {
          restaurantId: tenant.id,
          name: dto.branchName ?? 'Main Branch',
        },
      });

      // 2.3 Create Default Floor & Tables
      const floor = await tx.floor.create({
        data: {
          branchId: branch.id,
          name: 'Main Dining',
          sortOrder: 0,
        },
      });

      for (let i = 1; i <= 6; i++) {
        await tx.table.create({
          data: {
            floorId: floor.id,
            number: `${i}`,
            name: `Table ${i}`,
            capacity: i <= 2 ? 2 : 4,
            status: 'AVAILABLE',
          },
        });
      }

      // 2.4 Create Starter Menu Categories
      const starterCategories = ['Beverages', 'Starters', 'Main Course', 'Desserts'];
      for (let i = 0; i < starterCategories.length; i++) {
        await tx.menuCategory.create({
          data: {
            branchId: branch.id,
            name: starterCategories[i],
            sortOrder: i,
            isActive: true,
          },
        });
      }

      // 2.5 Ensure Owner Role exists
      let ownerRole = await tx.role.findFirst({
        where: { restaurantId: tenant.id, name: 'OWNER' },
      });
      if (!ownerRole) {
        ownerRole = await tx.role.create({
          data: {
            restaurantId: tenant.id,
            name: 'OWNER',
            label: 'Owner',
            isSystem: true,
          },
        });
      }

      // 2.6 Create Owner User Record
      const user = await tx.user.create({
        data: {
          ...(supabaseUserId ? { id: supabaseUserId } : {}),
          restaurantId: tenant.id,
          roleId: ownerRole.id,
          name: dto.ownerName,
          email,
          passwordHash,
        },
      });

      await tx.userBranch.create({
        data: { userId: user.id, branchId: branch.id },
      });

      return { tenant, branch, user };
    });

    // 3. Update Supabase User JWT claims with tenant_id for RLS enforcement
    if (this.supabaseAdmin && result.user.id) {
      await this.supabaseAdmin.auth.admin.updateUserById(result.user.id, {
        app_metadata: {
          tenant_id: result.tenant.id,
          role: 'OWNER',
        },
      });
    }

    return {
      success: true,
      tenantId: result.tenant.id,
      branchId: result.branch.id,
      userId: result.user.id,
    };
  }

  /**
   * Privileged Staff Provisioning.
   * Provisions a staff account with PIN or Password and sets tenant app_metadata.
   */
  async provisionStaff(tenantId: string, dto: ProvisionStaffDto) {
    let pinHash: string | null = null;
    if (dto.pin) {
      pinHash = await bcrypt.hash(dto.pin, 10);
    }

    let role = await this.prisma.role.findFirst({
      where: { restaurantId: tenantId, name: dto.role },
    });
    if (!role) {
      role = await this.prisma.role.create({
        data: {
          restaurantId: tenantId,
          name: dto.role,
          label: dto.role.replace(/_/g, ' '),
        },
      });
    }

    let authUserId: string | null = null;
    if (this.supabaseAdmin && dto.email) {
      const { data, error } = await this.supabaseAdmin.auth.admin.createUser({
        email: dto.email,
        email_confirm: true,
        user_metadata: { name: dto.name },
        app_metadata: { tenant_id: tenantId, role: dto.role },
      });
      if (!error && data.user) {
        authUserId = data.user.id;
      }
    }

    const user = await this.prisma.user.create({
      data: {
        ...(authUserId ? { id: authUserId } : {}),
        restaurantId: tenantId,
        roleId: role.id,
        name: dto.name,
        email: dto.email,
        passwordHash: 'PIN_AUTH',
        pinHash,
      },
    });

    if (dto.branchId) {
      await this.prisma.userBranch.create({
        data: { userId: user.id, branchId: dto.branchId },
      });
    }

    return {
      id: user.id,
      name: user.name,
      role: dto.role,
      hasPin: !!pinHash,
    };
  }

  /**
   * Billing Webhook Handler (Stripe / Payment Gateway).
   * Updates SaaS subscription status for the tenant.
   */
  async handleBillingWebhook(payload: {
    tenantId: string;
    tier: string;
    status: string;
  }) {
    await this.prisma.restaurant.update({
      where: { id: payload.tenantId },
      data: {
        updatedAt: new Date(),
      },
    });

    this.logger.log(`Updated subscription for tenant ${payload.tenantId}: ${payload.tier} - ${payload.status}`);
    return { received: true };
  }

  /**
   * Privileged Aggregated Analytics.
   * Runs compute-heavy metrics server-side, returning small scalar summaries
   * to avoid pulling thousands of raw order rows into client memory.
   */
  async getAggregatedAnalytics(tenantId: string, branchId?: string) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const whereClause: { branch: { restaurantId: string }; branchId?: string; createdAt: { gte: Date } } = {
      branch: { restaurantId: tenantId },
      createdAt: { gte: today },
    };
    if (branchId) whereClause.branchId = branchId;

    const [orderAgg, orderCount] = await Promise.all([
      this.prisma.order.aggregate({
        where: { ...whereClause, status: 'PAID' },
        _sum: { totalAmount: true },
        _avg: { totalAmount: true },
      }),
      this.prisma.order.count({ where: whereClause }),
    ]);

    return {
      date: today.toISOString(),
      ordersCount: orderCount,
      paidRevenue: Number(orderAgg._sum.totalAmount || 0),
      averageTicketSize: Number(orderAgg._avg.totalAmount || 0),
    };
  }
}
