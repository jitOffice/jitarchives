/**
 * 数据大盘统计接口（工作台）。
 *
 * - 需登录 + 档案查看权限（五类角色均可进入工作台，访客仅获得公开档案口径）；
 * - 统计范围与角色口径由服务端按会话角色判定，前端无法通过参数越权；
 * - 只读接口：不写业务表，不修改任何正式数据。
 */
import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { SessionGuard, PermissionGuard, CurrentUser, Perm } from '../auth/guards';
import { UserView } from '../common/roles';
import { DASHBOARD_RANGES, DashboardService, DashboardStatsView } from './dashboard.service';

@UseGuards(SessionGuard, PermissionGuard)
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly service: DashboardService) {}

  /** 数据大盘统计（累计口径 + 所选时间范围口径）。 */
  @Get('stats')
  @Perm('archiveView')
  stats(@CurrentUser() user: UserView, @Query('range') range?: string): DashboardStatsView {
    const key = String(range ?? '').trim();
    if (key && !(key in DASHBOARD_RANGES)) {
      throw new BadRequestException('统计时间范围不合法，仅支持最近 7 天、30 天或 90 天');
    }
    return this.service.stats(user, key || undefined);
  }
}
