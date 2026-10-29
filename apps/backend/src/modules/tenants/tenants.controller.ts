import {
  Body,
  Controller,
  Get,
  Headers,
  Post,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { SessionUser } from '@nodedr-restaurant/types';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Auth } from '../../common/decorators/auth.decorator';
import {
  OnboardTenantDto,
  ProvisionStaffDto,
  TenantsService,
} from './tenants.service';

@ApiTags('tenants')
@Controller('v1/tenants')
export class TenantsController {
  constructor(private readonly tenantsService: TenantsService) {}

  /**
   * Public/Registration endpoint for creating a new SaaS tenant
   */
  @Post('onboard')
  async onboard(@Body() body: OnboardTenantDto) {
    return this.tenantsService.onboardTenant(body);
  }

  /**
   * Privileged endpoint to provision staff accounts with Supabase Auth & PINs
   */
  @Auth('users.manage')
  @Post('staff')
  async provisionStaff(
    @CurrentUser() user: SessionUser,
    @Body() body: ProvisionStaffDto,
  ) {
    return this.tenantsService.provisionStaff(user.restaurantId, body);
  }

  /**
   * Billing webhook endpoint for Stripe / payment gateways
   */
  @Post('billing-webhook')
  async billingWebhook(
    @Headers('x-webhook-signature') signature: string,
    @Body() payload: { tenantId: string; tier: string; status: string },
  ) {
    const expectedSecret = process.env.BILLING_WEBHOOK_SECRET;
    if (expectedSecret && signature !== expectedSecret) {
      throw new UnauthorizedException('Invalid billing webhook signature');
    }
    return this.tenantsService.handleBillingWebhook(payload);
  }

  /**
   * Privileged aggregated analytics endpoint (Ultra-low egress scalar summary)
   */
  @UseGuards(JwtAuthGuard)
  @Get('analytics')
  async analytics(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId?: string,
  ) {
    return this.tenantsService.getAggregatedAnalytics(user.restaurantId, branchId);
  }
}
