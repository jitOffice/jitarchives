/**
 * 健康检查模块（功能四）：注册无鉴权 HealthController。
 * DATABASE 由全局 DatabaseModule 提供，本模块仅装配控制器。
 */
import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

@Module({
  controllers: [HealthController],
})
export class HealthModule {}
